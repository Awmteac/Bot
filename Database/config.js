const fs = require('fs-extra');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'settings.json');

const DEFAULT_SETTINGS = {
    botname: 'Mizo Bot',
    prefix: '.',
    owner: '',
    packname: 'Mizo Bot',
    author: 'Mizo Bot'
};

async function getSettings() {
    try {
        if (!fs.existsSync(CONFIG_PATH)) {
            fs.writeJsonSync(CONFIG_PATH, DEFAULT_SETTINGS, { spaces: 2 });
            return DEFAULT_SETTINGS;
        }
        const data = fs.readJsonSync(CONFIG_PATH);
        return { ...DEFAULT_SETTINGS, ...data };
    } catch (err) {
        console.error('[CONFIG]', err.message);
        return DEFAULT_SETTINGS;
    }
}

async function saveSettings(settings) {
    fs.writeJsonSync(CONFIG_PATH, settings, { spaces: 2 });
}

module.exports = { getSettings, saveSettings };
