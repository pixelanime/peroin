// ==========================================
// PEROIN BACKEND - Node.js + Express + Supabase
// ==========================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);

// Setup Socket.IO untuk fitur Real-Time (LIVE indicator)
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// Middleware
app.use(cors());
app.use(express.json());

// Inisialisasi Supabase Client
// Ambil URL dan Key dari file .env
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ==========================================
// ROUTES API (REST)
// ==========================================

// 1. Ambil semua pesanan (bisa filter status & marketplace)
app.get('/api/orders', async (req, res) => {
  const { status, marketplace, search, page = 1, limit = 10 } = req.query;
  
  let query = supabase.from('orders').select('*', { count: 'exact' }).order('created_at', { ascending: false });
  
  if (status && status !== 'semua') query = query.eq('status', status);
  if (marketplace && marketplace !== 'semua') query = query.eq('marketplace', marketplace);
  if (search) query = query.or(`id.ilike.%${search}%,pembeli.ilike.%${search}%,produk.ilike.%${search}%`);

  const from = (page - 1) * limit;
  const to = from + limit - 1;
  query = query.range(from, to);

  const { data, error, count } = await query;
  
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data, total: count, page: parseInt(page), limit: parseInt(limit) });
});

// 2. Ambil detail 1 pesanan
app.get('/api/orders/:id', async (req, res) => {
  const { data, error } = await supabase.from('orders').select('*').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: 'Pesanan tidak ditemukan' });
  res.json(data);
});

// 3. Ubah status pesanan (Proses, Kirim, Selesai, Batal)
app.patch('/api/orders/:id/status', async (req, res) => {
  const { status, kurir, resi } = req.body;
  
  const updateData = { status, updated_at: new Date().toISOString() };
  if (kurir) updateData.kurir = kurir;
  if (resi) updateData.resi = resi;

  const { data, error } = await supabase.from('orders').update(updateData).eq('id', req.params.id).select().single();
  
  if (error) return res.status(500).json({ error: error.message });
  
  // Kirim notifikasi real-time ke semua frontend yang sedang buka
  io.emit('orderUpdated', data);
  res.json(data);
});

// 4. Tambah pesanan baru (Dari Webhook Marketplace nantinya)
app.post('/api/orders', async (req, res) => {
  const { data, error } = await supabase.from('orders').insert([req.body]).select().single();
  
  if (error) return res.status(500).json({ error: error.message });
  
  // Kirim notifikasi real-time
  io.emit('newOrder', data);
  res.status(201).json(data);
});

// 5. Statistik Dashboard
app.get('/api/stats/dashboard', async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  
  // Hitung secara paralel menggunakan Promise.all biar cepat
  const [resHariIni, resBelumProses, resDikirim, resPendapatan] = await Promise.all([
    supabase.from('orders').select('id', { count: 'exact', head: true }).gte('created_at', today),
    supabase.from('orders').select('id', { count: 'exact', head: true }).in('status', ['baru', 'proses']),
    supabase.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'kirim'),
    supabase.from('orders').select('total').gte('created_at', today).neq('status', 'batal')
  ]);

  let pendapatan = 0;
  if (resPendapatan.data) {
    pendapatan = resPendapatan.data.reduce((sum, item) => sum + item.total, 0);
  }

  res.json({
    hariIni: resHariIni.count || 0,
    belumProses: resBelumProses.count || 0,
    dikirim: resDikirim.count || 0,
    pendapatan: pendapatan
  });
});

// 6. Log Notifikasi WhatsApp
app.get('/api/wa-logs', async (req, res) => {
  const { data, error } = await supabase.from('wa_logs').select('*').order('created_at', { ascending: false }).limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/wa-logs', async (req, res) => {
  const { data, error } = await supabase.from('wa_logs').insert([req.body]).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});
// 6b. Kirim WhatsApp Nyata via Fonnte
app.post('/api/send-wa', async (req, res) => {
  const { phone, message } = req.body;

  if (!phone || !message) {
    return res.status(400).json({ error: 'Phone dan message wajib diisi' });
  }

  try {
    const fonnteResponse = await fetch('https://api.fonnte.com/send', {
      method: 'POST',
      headers: {
        'Authorization': req.headers['x-fonnte-key'] || process.env.FONNTE_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        target: phone,
        message: message,
        countryCode: '62'
      })
    });

    const result = await fonnteResponse.json();
    
    // Simpan ke log WA
    await supabase.from('wa_logs').insert([{
      phone,
      order_id: message.match(/([A-Z]{2,3}\d{6})/)?.[1] || '-',
      type: 'Manual',
      status: result.status ? 'terkirim' : 'gagal',
      created_at: new Date().toISOString()
    }]);

    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// 7. Endpoint dummy untuk Webhook (Nanti diisi Shopee/Tokopedia)
app.post('/webhook/shopee', (req, res) => {
  console.log('Webhook Shopee diterima:', req.body);
  // TODO: Validasi signature, lalu insert ke DB
  res.json({ message: 'Webhook diterima' });
});

app.post('/webhook/tokopedia', (req, res) => {
  console.log('Webhook Tokopedia diterima:', req.body);
  res.json({ message: 'Webhook diterima' });
});


// ==========================================
// SOCKET.IO (Real-Time Connection)
// ==========================================
io.on('connection', (socket) => {
  console.log('Frontend terhubung:', socket.id);
  
  socket.on('disconnect', () => {
    console.log('Frontend terputus:', socket.id);
  });
});

// ==========================================
// JALANKAN SERVER
// ==========================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════╗
  ║     PEROIN BACKEND AKTIF          ║
  ║     Port: ${PORT}                   ║
  ║     Status: Ready                  ║
  ╚═══════════════════════════════════╝
  `);
});