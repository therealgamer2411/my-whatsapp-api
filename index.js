const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const app = express();

app.use(express.json());

// إعدادات خاصة لتشغيل المتصفح داخل Docker
const client = new Client({
    authStrategy: new LocalAuth(), // محاولة حفظ الجلسة
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process', 
            '--disable-gpu'
        ]
    }
});

client.on('qr', (qr) => {
    // السيرفر ليس له شاشة، سنطبع الكود في السجلات (Logs)
    console.log('QR RECEIVED', qr);
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('Client is ready!');
});

app.post('/send', async (req, res) => {
    const { phone, message } = req.body;
    const chatId = `${phone}@c.us`;
    try {
        await client.sendMessage(chatId, message);
        res.json({ status: 'success' });
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
});

client.initialize();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});