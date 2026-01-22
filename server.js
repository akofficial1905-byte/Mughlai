const express = require('express');
const http = require('http');
const socketio = require('socket.io');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = socketio(server);
const PORT = process.env.PORT || 3000;

// --- MongoDB connection ---
mongoose.connect('mongodb+srv://architmagic_db_user:v4TYaSl8O5zH4h60@mughlai.ttewbke.mongodb.net/mughlai?retryWrites=true&w=majority', {
  useNewUrlParser: true,
  useUnifiedTopology: true
});
mongoose.connection.on('connected', () => console.log('✅ Connected to MongoDB'));
mongoose.connection.on('error', (err) => console.error('❌ MongoDB Error:', err));

// --- Schema ---
const orderSchema = new mongoose.Schema({
  orderType: String,
  customerName: String,
  mobile: String,
  tableNumber: String,
  address: String,
  items: Array,
  total: Number,
  status: { type: String, default: 'incoming' },
  createdAt: { type: Date, default: Date.now }
});
const Order = mongoose.model('Order', orderSchema);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Serve menu file ---
app.get('/menu.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/menu.json'));
});

// --- Utility: Date boundaries in local time ---
function getDateBounds(dateStr) {
  const date = new Date(dateStr);
  const start = new Date(date.setHours(0, 0, 0, 0));
  const end = new Date(date.setHours(23, 59, 59, 999));
  return { start, end };
}

// ---------------- ORDERS APIs ----------------

// Get orders for a given date
app.get('/api/orders', async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const { start, end } = getDateBounds(date);
  const orders = await Order.find({
    createdAt: { $gte: start, $lte: end },
    status: { $ne: 'deleted' }
  }).sort({ createdAt: -1 });
  res.json(orders);
});

// Place new order
app.post('/api/orders', async (req, res) => {
  const { orderType, customerName, mobile, tableNumber, address, items } = req.body;
  const total = items.reduce((s, i) => s + i.price * i.qty, 0);
  const order = new Order({
    orderType,
    customerName,
    mobile,
    tableNumber,
    address,
    items,
    total,
    status: 'incoming'
  });
  await order.save();
  io.emit('newOrder', order); // real-time emit
  res.json(order);
});

// Update order status
app.patch('/api/orders/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const order = await Order.findByIdAndUpdate(id, { status }, { new: true });
  if (order) {
    io.emit('orderUpdated', order); // notify all managers
    res.json(order);
  } else {
    res.status(404).json({ error: 'Order not found' });
  }
});

// ---------------- DASHBOARD APIs ----------------

// Total sales for a day/week/month
app.get('/api/dashboard/sales', async (req, res) => {
  const period = req.query.period || 'day';
  const date = req.query.date || new Date().toISOString().slice(0, 10);

  let start, end;
  if (period === 'day') {
    ({ start, end } = getDateBounds(date));
  } else if (period === 'week') {
    const d = new Date(date);
    const first = new Date(d.setDate(d.getDate() - d.getDay()));
    start = new Date(first.setHours(0, 0, 0, 0));
    end = new Date(new Date(start).setDate(start.getDate() + 7));
  } else if (period === 'month') {
    const d = new Date(date);
    start = new Date(d.getFullYear(), d.getMonth(), 1);
    end = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
  }

  const orders = await Order.find({
    createdAt: { $gte: start, $lte: end },
    status: { $ne: 'deleted' }
  });
  const total = orders.reduce((sum, o) => sum + (o.total || 0), 0);
  res.json({ total, count: orders.length });
});

// Peak Hour
app.get('/api/dashboard/peakhour', async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const { start, end } = getDateBounds(date);
  const orders = await Order.find({ createdAt: { $gte: start, $lte: end }, status: { $ne: 'deleted' } });
  const hourly = {};
  orders.forEach(o => {
    const hour = new Date(o.createdAt).getHours();
    hourly[hour] = (hourly[hour] || 0) + 1;
  });
  let peak = { hour: '-', count: 0 };
  Object.entries(hourly).forEach(([h, c]) => {
    if (c > peak.count) peak = { hour: h, count: c };
  });
  res.json(peak);
});

// Most Ordered Dish
app.get('/api/dashboard/topdish', async (req, res) => {
  let start, end;
  if (req.query.from && req.query.to) {
    start = new Date(req.query.from);
    end = new Date(req.query.to);
  } else {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    ({ start, end } = getDateBounds(date));
  }
  const orders = await Order.find({ createdAt: { $gte: start, $lte: end }, status: { $ne: 'deleted' } });
  const countMap = {};
  orders.forEach(o => {
    o.items.forEach(i => {
      const n = i.name || 'Unnamed Item';
      countMap[n] = (countMap[n] || 0) + i.qty;
    });
  });
  const top = Object.entries(countMap).sort((a, b) => b[1] - a[1])[0];
  res.json(top ? { _id: top[0], count: top[1] } : null);
});

// Repeat Customers
app.get('/api/dashboard/repeatcustomers', async (req, res) => {
  let start, end;
  if (req.query.from && req.query.to) {
    start = new Date(req.query.from);
    end = new Date(req.query.to);
  } else {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    ({ start, end } = getDateBounds(date));
  }

  const nameFilter = req.query.name ? { customerName: req.query.name } : {};
  const orders = await Order.find({ createdAt: { $gte: start, $lte: end }, status: { $ne: 'deleted' }, ...nameFilter });

  const stats = {};
  orders.forEach(o => {
    if (!o.customerName) return;
    stats[o.customerName] = (stats[o.customerName] || 0) + 1;
  });

  if (req.query.name) {
    return res.json([{ _id: req.query.name, orders: stats[req.query.name] || 0 }]);
  }

  const sorted = Object.entries(stats).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ _id: name, orders: count }));
  res.json(sorted);
});

// ---------------- SOCKET.IO ----------------
io.on('connection', (socket) => {
  console.log('🟢 Manager connected');
  socket.emit('connected', { status: 'connected' });
});

// ---------------- HEALTH CHECK ----------------
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

// ---------------- SERVER ----------------
server.listen(PORT, () => {
  console.log(`🚀 Mughlai Point Server running on http://localhost:${PORT}`);
});

