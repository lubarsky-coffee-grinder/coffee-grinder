import { createBrowserContext } from './browser.js';
import { handleCaptcha } from './solver.js';
import { wait } from './utils.js';
import { log } from './log.js';
import { CONFIG } from './config.js';
import { finalyze } from './grinder/src/browse-article.js'; // Импорт вашей функции очистки если нужно

export async function browseArticle(url) {
    let browser, context, page;

    try {
        log(`Запуск браузера для: ${url}`);
        const session = await createBrowserContext();
        browser = session.browser;
        context = session.context;
        page = session.page;

        // 1. Переход на страницу
        await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: CONFIG.timeouts.pageLoad
        });

        // 2. Обработка капчи
        const captchaPassed = await handleCaptcha(page, url);

        if (!captchaPassed) {
            throw new Error('Не удалось пройти капчу');
        }

        // 3. Дополнительная проверка на Cloudflare "Checking your browser"
        // Ждем исчезновения типичных элементов защиты
        await page.waitForSelector('body', { state: 'visible' });
        const isBlocked = await page.evaluate(() => {
            return document.body.innerText.includes('Checking your browser') ||
                document.body.innerText.includes('DDoS protection');
        });

        if (isBlocked) {
            log('Обнаружен блок Cloudflare. Ждем...');
            await wait(10000);
        }

        // 4. Сбор данных (Ваша логика)
        log('Сбор контента...');

        // Пример: ждем загрузки основного контента
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

        const html = await page.evaluate(() => {
            // Ваш селектор для контента
            const body = document.querySelector('.body') || document.body;
            return body.innerHTML;
        });

        log('Успешно.');
        return html;

    } catch (e) {
        log('Критическая ошибка:', e.message);
        // Скриншот ошибки для отладки
        if (page) {
            await page.screenshot({ path: `error_${Date.now()}.png` });
        }
        return null;
    } finally {
        // Корректное закрытие
        if (browser) await browser.close();
    }
}
