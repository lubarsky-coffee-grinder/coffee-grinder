import os from 'os';
import path from 'path';

const platform = os.platform();

// Автоматическое определение пути к Chrome в зависимости от ОС
const getChromePath = () => {
    if (platform === 'win32') {
        return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    } else if (platform === 'darwin') {
        return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    }
    // Для Linux или если Chrome не найден, вернем null (будет использоваться встроенный Chromium)
    return null;
};

export const CONFIG = {
    headless: false, // Лучше false для отладки и обхода сложных защит
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    chromePath: getChromePath(),
    // Путь к профилю (кроссплатформенный)
    profilePath: platform === 'win32'
        ? path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Playwright Profile')
        : path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'Playwright Profile'),

    timeouts: {
        pageLoad: 60000,
        captchaWait: 120000,
    }
};