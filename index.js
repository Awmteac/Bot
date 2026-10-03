const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    downloadContentFromMessage,
    getContentType
} = require('@whiskeysockets/baileys');
const pino = require('pino');

// ── Helpers ────────────────────────────────────────────────────────
const _fmt = (msg) => `╭─❏ 「 MIZO BOT 」\n│ ${msg}\n╰───────────────`;

async function downloadMedia(sourceMsg, type) {
    const stream = await downloadContentFromMessage(sourceMsg, type);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
}

function unwrapMessage(msg) {
    if (!msg) return null;
    const type = getContentType(msg);
    if (!type) return msg;
    if (['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'ephemeralMessage'].includes(type)) {
        return unwrapMessage(msg[type]?.message);
    }
    return msg;
}

async function _sendStatusToGroup(client, jid, mediaType, buffer, caption) {
    const contextInfo = { 
        isGroupStatus: true, 
        statusSourceType: mediaType ? mediaType.toUpperCase() : 'TEXT', 
        statusAttributions: [{ type: 10 }], 
        statusAudienceMetadata: { audienceType: 'CLOSE_FRIENDS' } 
    };

    if (mediaType === 'image') {
        await client.sendMessage(jid, { image: buffer, caption: caption || '', contextInfo });
    } else if (mediaType === 'video') {
        await client.sendMessage(jid, { video: buffer, caption: caption || '', contextInfo });
    } else if (mediaType === 'audio') {
        await client.sendMessage(jid, { audio: buffer, mimetype: 'audio/mp4', ptt: true, contextInfo });
    } else {
        await client.sendMessage(jid, { text: caption || '', contextInfo });
    }
}

// ── Bot Startup ────────────────────────────────────────────────────
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./session');
    const { version } = await fetchLatestBaileysVersion();

    const client = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true, // Scan QR from terminal to login
        auth: state,
        browser: ['Mizo Bot', 'Chrome', '1.0.0']
    });

    client.ev.on('creds.update', saveCreds);

    client.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('✅ Bot connected successfully! Send .gstatus or .vv in a chat.');
        }
    });

    client.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const m = messages[0];
        if (!m.message) return;

        const chat = m.key.remoteJid;
        const isGroup = chat.endsWith('@g.us');

        // Extract body text
        const msgType = getContentType(m.message);
        let body = '';
        if (msgType === 'conversation') body = m.message.conversation;
        else if (msgType === 'extendedTextMessage') body = m.message.extendedTextMessage.text;
        else if (msgType === 'imageMessage') body = m.message.imageMessage.caption;
        else if (msgType === 'videoMessage') body = m.message.videoMessage.caption;

        const prefix = '.';
        if (!body || !body.startsWith(prefix)) return;

        const args = body.slice(prefix.length).trim().split(/\s+/);
        const cmd = (args.shift() || '').toLowerCase();

        const quoted = m.message?.extendedTextMessage?.contextInfo?.quotedMessage || null;

        // ════════════════════════════════════════════════════════════
        // COMMAND 1: VIEW ONCE (.vv / .viewonce)
        // ════════════════════════════════════════════════════════════
        if (cmd === 'vv' || cmd === 'viewonce') {
            if (!quoted) {
                return client.sendMessage(chat, { text: '❌ Reply to a view-once message.' }, { quoted: m });
            }

            const quotedType = getContentType(quoted);
            const isViewOnce = ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension'].includes(quotedType);

            if (!isViewOnce) {
                return client.sendMessage(chat, { text: '❌ Not a view-once message.' }, { quoted: m });
            }

            try {
                await client.sendMessage(chat, { react: { text: '⌛', key: m.key } });

                const innerMsg = unwrapMessage(quoted);
                const innerType = getContentType(innerMsg);
                let mediaType = innerType === 'imageMessage' ? 'image' : innerType === 'videoMessage' ? 'video' : innerType === 'audioMessage' ? 'audio' : null;

                if (!mediaType) {
                    await client.sendMessage(chat, { react: { text: '❌', key: m.key } });
                    return client.sendMessage(chat, { text: '❌ Unsupported view-once format.' }, { quoted: m });
                }

                const buffer = await downloadMedia(innerMsg[innerType], mediaType);
                const originalCaption = innerMsg[innerType].caption || '';

                if (mediaType === 'image') {
                    await client.sendMessage(chat, { image: buffer, caption: originalCaption }, { quoted: m });
                } else if (mediaType === 'video') {
                    await client.sendMessage(chat, { video: buffer, caption: originalCaption }, { quoted: m });
                } else if (mediaType === 'audio') {
                    await client.sendMessage(chat, { audio: buffer, mimetype: 'audio/mp4', ptt: true }, { quoted: m });
                }

                await client.sendMessage(chat, { react: { text: '✅', key: m.key } });
            } catch (err) {
                await client.sendMessage(chat, { react: { text: '❌', key: m.key } });
                await client.sendMessage(chat, { text: '❌ Error downloading view-once: ' + err.message }, { quoted: m });
            }
        }

        // ════════════════════════════════════════════════════════════
        // COMMAND 2: GROUP STATUS (.gstatus / .gs)
        // ════════════════════════════════════════════════════════════
        if (cmd === 'gstatus' || cmd === 'gs') {
            try {
                const afterCmd = args.join(' ').trim();
                const firstArg = (args[0] || '').toLowerCase();

                // ── Handle sending to ALL groups ──
                if (firstArg === 'all') {
                    await client.sendMessage(chat, { react: { text: '⌛', key: m.key } });

                    const inlineText = args.slice(1).join(' ').trim() || null;
                    let mediaType = null;
                    let sourceMsg = null;
                    let caption = inlineText;

                    if (m.message?.imageMessage) { sourceMsg = m.message.imageMessage; mediaType = 'image'; caption = m.message.imageMessage?.caption || inlineText || null; }
                    else if (m.message?.videoMessage) { sourceMsg = m.message.videoMessage; mediaType = 'video'; caption = m.message.videoMessage?.caption || inlineText || null; }
                    else if (m.message?.audioMessage) { sourceMsg = m.message.audioMessage; mediaType = 'audio'; }
                    else if (quoted?.imageMessage) { sourceMsg = quoted.imageMessage; mediaType = 'image'; caption = quoted.imageMessage?.caption || inlineText || null; }
                    else if (quoted?.videoMessage) { sourceMsg = quoted.videoMessage; mediaType = 'video'; caption = quoted.videoMessage?.caption || inlineText || null; }
                    else if (quoted?.audioMessage) { sourceMsg = quoted.audioMessage; mediaType = 'audio'; }

                    if (!sourceMsg && !inlineText) {
                        await client.sendMessage(chat, { react: { text: '❌', key: m.key } });
                        return client.sendMessage(chat, { text: _fmt('Reply to media or provide text.\n│ Example:\n│ .gstatus all Hello groups!') }, { quoted: m });
                    }

                    let buffer = null;
                    if (sourceMsg && mediaType) buffer = await downloadMedia(sourceMsg, mediaType);

                    const allGroups = await client.groupFetchAllParticipating();
                    const groupJids = Object.keys(allGroups);

                    if (!groupJids.length) {
                        await client.sendMessage(chat, { react: { text: '❌', key: m.key } });
                        return client.sendMessage(chat, { text: _fmt('Bot is not in any groups.') }, { quoted: m });
                    }

                    const results = { success: [], failed: [] };
                    for (const jid of groupJids) {
                        try {
                            await _sendStatusToGroup(client, jid, mediaType, buffer, caption);
                            results.success.push(allGroups[jid]?.subject || jid);
                        } catch (e) {
                            results.failed.push({ name: allGroups[jid]?.subject || jid, error: e.message.slice(0, 50) });
                        }
                        await new Promise(r => setTimeout(r, 600)); // Sleep to prevent rate-limiting bans
                    }

                    await client.sendMessage(chat, { react: { text: '✅', key: m.key } });
                    let report = `╭─❏ 「 GSTATUS REPORT 」\n│\n│ ✅ Success: ${results.success.length}/${groupJids.length}\n│ ❌ Failed: ${results.failed.length}/${groupJids.length}`;
                    if (results.failed.length) {
                        report += '\n│\n│ 📋 Failed:';
                        for (const f of results.failed) report += `\n│  • ${f.name}: ${f.error}`;
                    }
                    report += '\n╰───────────────';
                    return client.sendMessage(chat, { text: report }, { quoted: m });
                }

                // ── Handle sending to a Specific Group or Current Group ──
                let targetGroupJid = null;
                let inlineText = null;

                if (isGroup) {
                    targetGroupJid = chat;
                    inlineText = afterCmd || null;
                } else {
                    if (!afterCmd) {
                        await client.sendMessage(chat, { react: { text: '❌', key: m.key } });
                        return client.sendMessage(chat, { text: _fmt(`Provide a group link or JID.\n│ Example:\n│ .gstatus https://chat.whatsapp.com/xxxxx\n│ .gstatus 120363@g.us\n│ .gstatus all (Send to all groups)`) }, { quoted: m });
                    }

                    const input = args[0];
                    const rest = args.slice(1).join(' ').trim();

                    if (input.includes('chat.whatsapp.com')) {
                        let code = input.split('/').pop();
                        try {
                            const res = await client.groupGetInviteInfo(code);
                            targetGroupJid = res?.id || res?.groupId;
                            if (!targetGroupJid) throw new Error();
                        } catch {
                            await client.sendMessage(chat, { react: { text: '❌', key: m.key } });
                            return client.sendMessage(chat, { text: _fmt('Invalid or expired group link.') }, { quoted: m });
                        }
                    } else if (input.includes('@g.us')) {
                        targetGroupJid = input.trim();
                    } else {
                        await client.sendMessage(chat, { react: { text: '❌', key: m.key } });
                        return client.sendMessage(chat, { text: _fmt('Invalid group link or JID.') }, { quoted: m });
                    }
                    inlineText = rest || null;
                }

                await client.sendMessage(chat, { react: { text: '⌛', key: m.key } });

                let caption = null;
                let sourceMsg = null;
                let mediaType = null;

                if (m.message?.imageMessage) { sourceMsg = m.message.imageMessage; mediaType = 'image'; caption = m.message.imageMessage?.caption || inlineText || null; }
                else if (m.message?.videoMessage) { sourceMsg = m.message.videoMessage; mediaType = 'video'; caption = m.message.videoMessage?.caption || inlineText || null; }
                else if (m.message?.audioMessage) { sourceMsg = m.message.audioMessage; mediaType = 'audio'; }
                else if (quoted?.imageMessage) { sourceMsg = quoted.imageMessage; mediaType = 'image'; caption = quoted.imageMessage?.caption || inlineText || null; }
                else if (quoted?.videoMessage) { sourceMsg = quoted.videoMessage; mediaType = 'video'; caption = quoted.videoMessage?.caption || inlineText || null; }
                else if (quoted?.audioMessage) { sourceMsg = quoted.audioMessage; mediaType = 'audio'; }
                else if (quoted?.conversation || quoted?.extendedTextMessage?.text) {
                    caption = (quoted.conversation || quoted.extendedTextMessage.text) + (inlineText ? '\n' + inlineText : '');
                }

                caption = caption || inlineText || null;
                if (!sourceMsg && !caption) {
                    await client.sendMessage(chat, { react: { text: '❌', key: m.key } });
                    return client.sendMessage(chat, { text: _fmt('Reply to media/text or add text after the command.') }, { quoted: m });
                }

                let buffer = null;
                if (sourceMsg && mediaType) buffer = await downloadMedia(sourceMsg, mediaType);

                await _sendStatusToGroup(client, targetGroupJid, mediaType, buffer, caption);

                await client.sendMessage(chat, { react: { text: '✅', key: m.key } });
                if (!isGroup) {
                    await client.sendMessage(chat, { text: _fmt('✅ Status posted to group!') }, { quoted: m });
                }

            } catch (error) {
                console.error(error);
                await client.sendMessage(chat, { react: { text: '❌', key: m.key } });
                await client.sendMessage(chat, { text: _fmt('Error: ' + error.message) }, { quoted: m });
            }
        }
    });
}

startBot();
