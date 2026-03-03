import { chromium } from 'playwright';
import { playwrightStealth } from 'playwright-stealth';
import { CONFIG } from './config.js';

export async function createBrowserContext() {
    // Запускаем браузер
    const browser = await chromium.launch({
        headless: CONFIG.headless,
        executablePath: CONFIG.chromePath, // Или оставьте null для встроенного
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    });

    const context = await browser.newContext({
        viewport: CONFIG.viewport,
        userAgent: CONFIG.userAgent,
        locale: 'en-US',
        timezoneId: 'America/New_York', // Маскировка геолокации
        permissions: ['geolocation'],
        geolocation: { longitude: -74.0060, latitude: 40.7128 }, // Нью-Йорк
    });

    // Применяем Stealth плагин к контексту
    await playwrightStealth(context);

    const page = await context.newPage();

    // Дополнительные маскировки через eval
    await page.addInitScript(() => {
        // Переопределение navigator.webdriver
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        // Скрытие плагинов
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        // Скрытие языка
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    });

    return { browser, context, page };
}