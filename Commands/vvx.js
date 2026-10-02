module.exports = {
    name: 'vvx',
    aliases: ['viewonce', 'vv'],
    description: 'Reveals view-once image or video.',
    run: async (context) => {
        const { client, m } = context;

        const send = async (text) => {
            await client.sendMessage(m.chat, { text }, { quoted: m });
        };

        if (!m.quoted) return send('❌ Reply to a view-once image or video.');

        try {
            const q = m.quoted;
            const raw = q.msg || q;
            const mtype = (q.mtype || raw.mtype || '').toLowerCase();
            const mime = raw.mimetype || q.mimetype || '';

            const isImage = mtype.includes('image') || mime.includes('image');
            const isVideo = mtype.includes('video') || mime.includes('video');

            if (!isImage && !isVideo) {
                return send('❌ Not a view-once image or video. Reply directly to the view-once message.');
            }

            const mediaType = isVideo ? 'video' : 'image';

            let buffer = null;
            if (typeof q.download === 'function') {
                buffer = await q.download();
            } else {
                buffer = await client.downloadMediaMessage(q);
            }

            if (!buffer || buffer.length === 0) return send('❌ Failed to download. Try again.');

            await client.sendMessage(m.chat, {
                [mediaType]: buffer,
                caption: '🔰 *Mizo Bot*'
            });

        } catch (error) {
            console.error('[VVX ERROR]', error.message);
            send('❌ Error: ' + error.message);
        }
    }
};
