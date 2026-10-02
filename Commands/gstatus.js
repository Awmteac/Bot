const { getSettings } = require('../Database/config');

const CHANNEL_JID = '120363322386211344@newsletter';
const CHANNEL_NAME = 'Omoma Chhakchhuak';
const channelInfo = { newsletterJid: CHANNEL_JID, newsletterName: CHANNEL_NAME };

async function downloadBuffer(client, msg) {
    if (typeof msg.download === 'function') return await msg.download();
    return await client.downloadMediaMessage(msg);
}

module.exports = {
    name: 'gstatus',
    aliases: ['groupstatus', 'gs'],
    description: 'Posts one or multiple group statuses.',
    run: async (context) => {
        const { client, m, prefix, IsGroup, botname } = context;

        const fmt = (text) =>
`╭─〔 📢 Group Status 〕─╮
│ ${text.replace(/\n/g, '\n│ ')}
╰───────────────────╯`;

        try {
            if (!botname) return client.sendMessage(m.chat, { text: fmt('Bot name is not set.') }, { quoted: m });
            if (!IsGroup) return client.sendMessage(m.chat, { text: fmt('This command can only be used in group chats.') }, { quoted: m });

            const settings = await getSettings();
            if (!settings) return client.sendMessage(m.chat, { text: fmt('Failed to load settings.') }, { quoted: m });

            const caption = m.body
                .replace(new RegExp(`^\\${prefix}(gstatus|groupstatus|gs)\\s*`, 'i'), '')
                .trim();

            const quoted = m.quoted ? m.quoted : m;
            const raw = quoted.msg || quoted;
            const mime = raw.mimetype || quoted.mimetype || '';
            const mtype = (quoted.mtype || raw.mtype || '').toLowerCase();

            // ── ALBUM ─────────────────────────────────────────
            const albumItems = raw.albumMessage || quoted.albumMessage;
            if (albumItems && Array.isArray(albumItems) && albumItems.length > 0) {
                const mediaArray = [];
                for (const item of albumItems) {
                    const buf = await downloadBuffer(client, item);
                    const itemMime = (item.msg || item).mimetype || '';
                    if (/image/.test(itemMime)) {
                        mediaArray.push({ image: buf, caption: caption || '' });
                    } else if (/video/.test(itemMime)) {
                        mediaArray.push({ video: buf, caption: caption || '' });
                    }
                }
                if (mediaArray.length > 0) {
                    await client.sendMessage(m.chat, { albumMessage: mediaArray });
                    return;
                }
            }

            // ── SINGLE IMAGE ──────────────────────────────────
            if (/image/.test(mime) || mtype.includes('image')) {
                const buffer = await downloadBuffer(client, quoted);
                return await client.sendMessage(m.chat, {
                    groupStatusMessage: { image: buffer, caption: caption || '', ...channelInfo }
                });
            }

            // ── SINGLE VIDEO ──────────────────────────────────
            if (/video/.test(mime) || mtype.includes('video')) {
                const buffer = await downloadBuffer(client, quoted);
                return await client.sendMessage(m.chat, {
                    groupStatusMessage: { video: buffer, caption: caption || '', ...channelInfo }
                });
            }

            // ── AUDIO ─────────────────────────────────────────
            if (/audio/.test(mime) || mtype.includes('audio')) {
                const buffer = await downloadBuffer(client, quoted);
                return await client.sendMessage(m.chat, {
                    groupStatusMessage: { audio: buffer, mimetype: 'audio/mp4', ...channelInfo }
                });
            }

            // ── TEXT ──────────────────────────────────────────
            if (caption) {
                return await client.sendMessage(m.chat, {
                    groupStatusMessage: { text: caption, ...channelInfo }
                });
            }

            return client.sendMessage(
                m.chat,
                {
                    text: fmt(
                        `Reply to an image, video, audio, or album — or include text.\n\n` +
                        `*Single:* Reply to 1 image/video + ${prefix}gstatus\n` +
                        `*Multiple:* Reply to an album + ${prefix}gstatus\n` +
                        `*Text:* ${prefix}gstatus Your message here`
                    )
                },
                { quoted: m }
            );

        } catch (error) {
            console.error('[GSTATUS]', error.message);
            await client.sendMessage(m.chat, { text: fmt(`Error: ${error.message}`) }, { quoted: m });
        }
    }
};
