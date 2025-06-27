const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

let minPrice = 0;
let maxPrice = 999999;
let dateFilter = 'сегодня';
let CHAT_ID = null;
let availableChats = [];
let seen = new Set();
let sentLog = [];
let qrCodeData = '';

const SEEN_PATH = 'seen.json';
if (fs.existsSync(SEEN_PATH)) {
    seen = new Set(JSON.parse(fs.readFileSync(SEEN_PATH, 'utf-8')));
}
function saveSeen() {
    fs.writeFileSync(SEEN_PATH, JSON.stringify([...seen]), 'utf-8');
}
function log(msg) {
    console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

const client = new Client({ authStrategy: new LocalAuth() });

client.on('qr', async (qr) => {
    qrCodeData = await qrcode.toDataURL(qr);
    log('📱 Сканируй QR-код на http://localhost:3000');
});

client.on('ready', async () => {
    const chats = await client.getChats();
    availableChats = chats.filter(c => c.isGroup || c.isUser).map(c => ({
        id: c.id._serialized,
        name: c.name || c.id.user
    }));
    log('✅ WhatsApp подключён');
    monitor(); // первый запуск
    setInterval(monitor, 30 * 60 * 1000); // каждые 30 мин
});

client.initialize();

async function getFirstNewAd(min, max, dateKey) {
    const res = await axios.get('https://doska.ykt.ru/');
    const $ = cheerio.load(res.data);

    for (const el of $('.d-post').toArray()) {
        const url = 'https://doska.ykt.ru' + $(el).find('a.d-post_link').attr('href');
        const title = $(el).find('.d-post_desc').text().trim();
        const priceText = $(el).find('.d-post_price').text().replace(/[^\d]/g, '');
        const price = parseInt(priceText || '0');
        const image = $(el).find('img').attr('src');
        const date = $(el).find('.d-post_date').text().trim().toLowerCase();
        const shortDesc = $(el).find('.d-post_text').text().trim().slice(0, 200);

        if (!seen.has(url) && price >= min && price <= max && date.includes(dateKey.toLowerCase())) {
            seen.add(url);
            saveSeen();
            return { title, price, url, image, date, shortDesc };
        }
    }

    return null;
}

async function monitor() {
    if (!CHAT_ID) {
        log('❗ CHAT_ID не задан');
        return;
    }

    const ad = await getFirstNewAd(minPrice, maxPrice, dateFilter);
    if (!ad) {
        log('📭 Нет новых объявлений');
        return;
    }

    const text = `🆕 Объявление
🔤 ${ad.title}
💰 ${ad.price} ₽
📅 ${ad.date}
📄 ${ad.shortDesc || '—'}
🔗 ${ad.url}`;

    try {
        if (ad.image) {
            const media = await MessageMedia.fromUrl(ad.image);
            await client.sendMessage(CHAT_ID, media, { caption: text });
        } else {
            await client.sendMessage(CHAT_ID, text);
        }

        log(`📤 Отправлено: ${ad.title}`);
        sentLog.unshift({ ...ad, time: new Date().toLocaleString() });
        if (sentLog.length > 50) sentLog.length = 50;
    } catch (err) {
        log(`❌ Ошибка при отправке: ${err.message}`);
    }
}

// === ВЕБ ИНТЕРФЕЙС ===

app.get('/', (req, res) => {
    if (!client.info) {
        return res.send(`
            <!DOCTYPE html>
            <html lang="ru">
            <head>
              <meta charset="UTF-8">
              <title>Сканируй QR-код</title>
              <style>
                body { font-family: sans-serif; text-align: center; padding: 40px; background: #f4f4f4; }
                img { border: 1px solid #ccc; background: #fff; padding: 10px; max-width: 300px; }
              </style>
            </head>
            <body>
              <h2>📱 Сканируй QR-код для входа в WhatsApp</h2>
              <p>Открой WhatsApp → Меню → WhatsApp Web → Сканируй код:</p>
              <img src="/qr" alt="QR-код WhatsApp">
              <p>⏳ Страница обновится через 5 секунд...</p>
              <script>setTimeout(() => location.reload(), 5000);</script>
            </body>
            </html>
        `);
    }

    const options = availableChats.map(c =>
        `<option value="${c.id}" ${c.id === CHAT_ID ? 'selected' : ''}>${c.name}</option>`
    ).join('');

    return res.send(`
        <!DOCTYPE html>
        <html lang="ru">
        <head>
          <meta charset="UTF-8">
          <title>Фильтр объявлений</title>
          <style>
            body {
              font-family: sans-serif;
              max-width: 600px;
              margin: 30px auto;
              background: #f4f4f4;
              padding: 20px;
              border-radius: 10px;
            }
            label {
              display: block;
              margin: 10px 0 5px;
            }
            input, select {
              width: 100%;
              padding: 8px;
              font-size: 16px;
            }
            button {
              margin-top: 20px;
              width: 100%;
              padding: 10px;
              font-size: 16px;
              background: #28a745;
              color: white;
              border: none;
              border-radius: 5px;
            }
            h1 {
              text-align: center;
            }
            .link {
              display: block;
              margin-top: 15px;
              text-align: center;
            }
          </style>
        </head>
        <body>
          <h1>Настройка фильтра</h1>
          <form action="/set" method="POST">
            <label for="min">Минимальная цена:</label>
            <input type="number" id="min" name="min" min="0" value="${minPrice}">

            <label for="max">Максимальная цена:</label>
            <input type="number" id="max" name="max" min="0" value="${maxPrice}">

            <label for="date">Фильтр по дате:</label>
            <select id="date" name="date">
              <option value="сегодня" ${dateFilter === 'сегодня' ? 'selected' : ''}>Сегодня</option>
              <option value="вчера" ${dateFilter === 'вчера' ? 'selected' : ''}>Вчера</option>
              <option value="" ${dateFilter === '' ? 'selected' : ''}>Все даты</option>
            </select>

            <label for="chat">Куда отправлять:</label>
            <select id="chat" name="chat">
              ${options}
            </select>

            <button type="submit">💾 Сохранить</button>
          </form>

          <a class="link" href="/log">📜 Лог отправок</a>
        </body>
        </html>
    `);
});

app.get('/qr', (req, res) => {
    if (!qrCodeData) {
        return res.status(404).send('QR-код ещё не готов');
    }
    const base64 = qrCodeData.replace(/^data:image\/png;base64,/, '');
    const imgBuffer = Buffer.from(base64, 'base64');
    res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': imgBuffer.length
    });
    res.end(imgBuffer);
});

app.post('/set', (req, res) => {
    minPrice = parseInt(req.body.min || '0');
    maxPrice = parseInt(req.body.max || '999999');
    dateFilter = req.body.date || 'сегодня';
    CHAT_ID = req.body.chat || null;
    log(`✅ Фильтры обновлены: min=${minPrice}, max=${maxPrice}, дата=${dateFilter}, чат=${CHAT_ID}`);
    res.redirect('/');
});

app.get('/log', (req, res) => {
    const html = sentLog.map(ad => `
        <div style="margin:10px 0;padding:10px;border:1px solid #ccc">
            <strong>${ad.time}</strong><br>
            <b>${ad.title}</b> — ${ad.price} ₽ — ${ad.date}<br>
            <small>${ad.shortDesc}</small><br>
            <a href="${ad.url}" target="_blank">🔗 Открыть</a>
        </div>
    `).join('');
    res.send(`<h2>Лог отправок</h2>${html}<br><a href="/">⬅ Назад</a>`);
});
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => log(`🌐 Интерфейс: http://localhost:${PORT}`));
