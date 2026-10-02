const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    getContentType
} = require('@whiskeysockets/baileys');

const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs-extra');
const path = require('path');
const readline = require('readline');
const http = require('http');
const QRCode = require('qrcode');

const { getSettings } = require('./Database/config');

// ── Login mode ────────────────────────────────────────────
// LOGIN_METHOD=qr       → scan QR on the web page  (recommended)
// LOGIN_METHOD=pairing  → 8-digit code (needs PAIRING_NUMBER)
// Default: pairing if PAIRING_NUMBER is set, otherwise qr
const LOGIN_METHOD = (process.env.LOGIN_METHOD || (process.env.PAIRING_NUMBER ? 'pairing' : 'qr')).toLowerCase();

// ── QR / status state ─────────────────────────────────────
let latestQR = null;
let isConnected = false;

// ── HTTP server: QR page + keep-alive ─────────────────────
const PORT = process.env.PORT || 3000;

const page = (title, body) => `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="15">
<title>${title}</title>
<style>
  body { margin:0; min-height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center;
         background:#0b141a; color:#e9edef; font-family:system-ui,sans-serif; text-align:center; padding:20px; }
  img { width:280px; height:280px; background:#fff; padding:16px; border-radius:16px; }
  .ok { color:#25d366; font-size:22px; font-weight:700; }
  .dim { color:#8696a0; margin-top:14px; }
</style>
</head><body>${body}</body></html>`;

http.createServer(async (req, res) => {
    try {
        if (req.url === '/qr') {
            res.writeHead(200, { 'Content-Type': 'text/html' });

            if (isConnected) {
                return res.end(page('Mizo Bot', '<div class="ok">✅ Bot is connected to WhatsApp</div><div class="dim">You can close this page.</div>'));
            }
            if (LOGIN_METHOD === 'pairing') {
                return res.end(page('Mizo Bot', '<div class="ok">🔑 Pairing-code mode</div><div class="dim">Check the Railway logs for your 8-digit code.</div>'));
            }
            if (!latestQR) {
                return res.end(page('Mizo Bot', '<div class="ok">⏳ Waiting for QR code…</div><div class="dim">This page refreshes automatically every 15 seconds.</div>'));
            }

            const dataUrl = await QRCode.toDataURL(latestQR, { scale: 8, margin: 1 });
            return res.end(page('Scan QR - Mizo Bot',
                `<img src="${dataUrl}" alt="QR code">` +
                '<div class="dim">WhatsApp → Settings → Linked Devices → Link a Device → scan this<br>Page auto-refreshes — if the QR changed, just scan the new one.</div>'));
        }

        // root: simple status
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(isConnected ? 'Mizo Bot: CONNECTED' : 'Mizo Bot: waiting for login (open /qr)');
    } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('error: ' + err.message);
    }
}).listen(PORT, () => console.log(`🌐 HTTP server listening on port ${PORT} (QR page: /qr)`));

// ── Load commands (safe: folder is auto-created, missing folder no longer crashes) ──
const commands = new Map();
const aliases = new Map();

const commandsDir = path.join(__dirname, 'Commands');
fs.ensureDirSync(commandsDir);

const commandFiles = fs.readdirSync(commandsDir).filter(f => f.endsWith('.js'));

for (const file of commandFiles) {
    try {
        const cmd = require(path.join(commandsDir, file));
        const name = cmd.name || file.replace('.js', '');
        commands.set(name, cmd);
        if (cmd.aliases) {
            for (const a of cmd.aliases) aliases.set(a, name);
        }
        console.log(`✅ Loaded command: ${name}`);
    } catch (err) {
        console.error(`❌ Failed to load ${file}:`, err.message);
    }
}

// ── Ask question helper (only used for local runs) ────────
function question(prompt) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => rl.question(prompt, (ans) => {
        rl.close();
        resolve(ans.trim());
    }));
}

// ── Helpers ───────────────────────────────────────────────
function unwrapMessage(message) {
    if (!message) return message;
    const type = getContentType(message);
    if (!type) return message;

    if (type === 'viewOnceMessage' || type === 'viewOnceMessageV2' || type === 'viewOnceMessageV2Extension') {
        return unwrapMessage(message[type]?.message);
    }
    if (type === 'ephemeralMessage') {
        return unwrapMessage(message[type]?.message);
    }
    if (type === 'documentWithCaptionMessage') {
        return unwrapMessage(message[type]?.message);
    }
    return message;
}

function getMimeType(message) {
    if (!message) return '';
    const type = getContentType(message);
    if (!type) return '';
    return message[type]?.mimetype || '';
}

// ── Build a context for each command ──────────────────────
function buildContext(sock, msg, prefix, botname) {
    const chatJid = msg.key.remoteJid;
    const isGroup = chatJid.endsWith('@g.us');
    const sender = isGroup ? (msg.key.participant || chatJid) : chatJid;
    const body =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        '';

    const inner = unwrapMessage(msg.message);

    let quoted = null;
    const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (quotedMsg) {
        const unwrapped = unwrapMessage(quotedMsg);
        const qType = getContentType(unwrapped);
        const qContent = qType ? unwrapped[qType] : {};

        quoted = {
            key: {
                remoteJid: chatJid,
                fromMe: false,
                id: msg.message.extendedTextMessage.contextInfo.stanzaId,
                participant: msg.message.extendedTextMessage.contextInfo.participant
            },
            message: unwrapped,
            mtype: qType || '',
            mimetype: qContent?.mimetype || '',
            msg: { ...qContent, mtype: qType, mimetype: qContent?.mimetype },
            download: async () => {
                if (!qType) throw new Error('No media to download.');
                let mediaType = 'document';
                if (qType.includes('image')) mediaType = 'image';
                else if (qType.includes('video')) mediaType = 'video';
                else if (qType.includes('audio')) mediaType = 'audio';

                const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
                const stream = await downloadContentFromMessage(qContent, mediaType);
                let buffer = Buffer.from([]);
                for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                return buffer;
            }
        };
    }

    const m = {
        key: msg.key,
        chat: chatJid,
        sender,
        isGroup,
        body,
        message: inner,
        mtype: getContentType(inner) || '',
        mimetype: getMimeType(inner),
        msg: inner,
        quoted,
        download: async () => {
            const type = getContentType(inner);
            if (!type) throw new Error('No media to download.');
            let mediaType = 'document';
            if (type.includes('image')) mediaType = 'image';
            else if (type.includes('video')) mediaType = 'video';
            else if (type.includes('audio')) mediaType = 'audio';

            const content = inner[type];
            const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
            const stream = await downloadContentFromMessage(content, mediaType);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
            return buffer;
        },
        reply: async (text) => {
            await sock.sendMessage(chatJid, { text }, { quoted: msg });
        }
    };

    return {
        client: sock,
        m,
        msg,
        prefix,
        IsGroup: isGroup,
        botname,
        sender,
        chat: chatJid
    };
}

// ── Get phone number: env var first (Railway), keyboard fallback (Termux/PC) ──
async function getPhoneNumber() {
    const envNum = (process.env.PAIRING_NUMBER || '').replace(/[^0-9]/g, '');
    if (envNum.length >= 8) {
        console.log(`📱 Using PAIRING_NUMBER from environment: ${envNum}`);
        return envNum;
    }

    // Local run only — Railway has no keyboard, so set PAIRING_NUMBER there
    let phoneNumber = await question('📱 Enter your WhatsApp number with country code (e.g. 2637xxxxxxxx): ');
    return phoneNumber.replace(/[^0-9]/g, '');
}

// ── Pairing code flow ─────────────────────────────────────
async function requestPairing(sock) {
    const phoneNumber = await getPhoneNumber();

    if (!phoneNumber || phoneNumber.length < 8) {
        console.log('❌ Invalid phone number. Set the PAIRING_NUMBER variable and redeploy.');
        process.exit(1);
    }

    // Give the socket a moment to reach WhatsApp servers before requesting the code
    await new Promise(r => setTimeout(r, 3000));

    try {
        const code = await sock.requestPairingCode(phoneNumber);
        const pretty = code?.match(/.{1,4}/g)?.join('-') || code;
        console.log('\n╭─────────────────────────────╮');
        console.log('│   🔑 YOUR PAIRING CODE      │');
        console.log('├─────────────────────────────┤');
        console.log(`│          ${pretty}            │`);
        console.log('╰─────────────────────────────╯\n');
        console.log('📲 Enter it in WhatsApp → Linked Devices → Link with phone number (expires ~60s)\n');
    } catch (err) {
        console.error('❌ Failed to get pairing code:', err.message);
        console.log('💡 Check the number and internet, then restart to try again.');
        process.exit(1);
    }
}

// ── Start bot ─────────────────────────────────────────────
async function startBot() {
    // AUTH_DIR lets you point the session at a Railway Volume so it survives redeploys
    const authDir = process.env.AUTH_DIR || './auth_info';
    fs.ensureDirSync(authDir);

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: ['Mizo Bot', 'Chrome', '1.0.0'],
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
        mobile: false
    });

    if (!sock.authState.creds.registered && LOGIN_METHOD === 'pairing') {
        await requestPairing(sock);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            latestQR = qr;
            console.log('📷 New QR code ready — open your Railway URL + /qr in your browser and scan it');
        }

        if (connection === 'close') {
            isConnected = false;
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
            if (statusCode === DisconnectReason.loggedOut) {
                console.log('❌ Logged out. Clear the auth_info volume/folder and redeploy to log in again.');
                return;
            }
            console.log('🔄 Connection closed, reconnecting...');
            startBot();
        } else if (connection === 'open') {
            isConnected = true;
            latestQR = null;
            console.log('✅ Bot connected successfully! Send .gstatus or .vvx in a chat to test.');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            try {
                if (!msg.message) continue;
                // NOTE: we intentionally do NOT skip msg.key.fromMe here.
                // The bot is paired to your own number, so your own messages
                // are the commands — skipping them makes the bot ignore you.

                const settings = await getSettings();
                const prefix = settings.prefix || '.';
                const botname = settings.botname || 'Mizo Bot';

                const body =
                    msg.message?.conversation ||
                    msg.message?.extendedTextMessage?.text ||
                    msg.message?.imageMessage?.caption ||
                    msg.message?.videoMessage?.caption ||
                    '';

                if (!body || !body.startsWith(prefix)) continue;

                const args = body.slice(prefix.length).trim().split(/\s+/);
                const cmdName = (args.shift() || '').toLowerCase();

                const resolvedName = aliases.get(cmdName) || cmdName;
                const command = commands.get(resolvedName);

                if (!command) continue;

                console.log(`⚡ Executing: ${resolvedName}`);

                const context = buildContext(sock, msg, prefix, botname);
                await command.run(context);

            } catch (err) {
                console.error('[MESSAGE ERROR]', err);
                try {
                    await sock.sendMessage(msg.key.remoteJid, {
                        text: `❌ Error: ${err.message}`
                    }, { quoted: msg });
                } catch (_) {}
            }
        }
    });

    return sock;
}

// ── Entry ─────────────────────────────────────────────────
console.log('🚀 Starting Mizo Bot...\n');
console.log(`🔐 Login method: ${LOGIN_METHOD}`);
startBot().catch(err => console.error('[FATAL]', err));
