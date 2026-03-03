import { wait, humanClick } from './utils.js';
import { log } from './log.js'; // Ваша функция логирования

// Проверка на наличие капчи
export async function detectCaptcha(page) {
    const selectors = [
        'iframe[src*="recaptcha"]',
        'iframe[src*="turnstile"]',
        '#cf-turnstile',
        '.px-captcha',
        '#challenge-form'
    ];

    for (const selector of selectors) {
        const element = await page.$(selector);
        if (element) return { detected: true, type: selector };
    }
    return { detected: false, type: null };
}

// Попытка бесплатного решения (клик по чекбоксу)
export async function tryFreeSolve(page) {
    log('Попытка бесплатного решения (клик)...');

    // Чекбокс reCAPTCHA v2
    const recaptchaCheckbox = await page.$('#recaptcha-anchor');
    if (recaptchaCheckbox) {
        await humanClick(page, '#recaptcha-anchor');
        await wait(5000); // Ждем проверки
        return true;
    }

    // Cloudflare Turnstile (иногда срабатывает просто ожидание или клик по невидимому)
    const turnstile = await page.$('#cf-turnstile');
    if (turnstile) {
        // Turnstile часто решается сам, если браузер чистый. Ждем.
        await wait(10000);
        return true;
    }

    return false;
}

// Платное решение (пример для CapSolver)
export async function tryPaidSolve(page, url) {
    const apiKey = process.env.CAPSOLVER_API_KEY;
    if (!apiKey || process.env.USE_PAID_SOLVER !== 'true') {
        log('Платный солвер отключен или нет ключа.');
        return null;
    }

    log('Запуск платного солвера...');

    // Пример логики (псевдокод, требует реальной реализации API)
    try {
        // 1. Отправляем задачу на API
        // const response = await fetch('https://api.capsolver.com/createTask ', { ... })
        // 2. Получаем taskId
        // 3. Поллим результат
        // 4. Внедряем токен в страницу

        // ВНИМАНИЕ: Это требует реализации HTTP запросов к сервису капчи
        // Ниже пример того, куда вставлять токен, если вы его получили

        /*
        const token = "P0_eyJ2MSI6...";
        await page.evaluate((token) => {
            document.getElementById('g-recaptcha-response').innerHTML = token;
            // Или для Turnstile
            document.getElementById('cf-turnstile-response').innerHTML = token;
        }, token);
        */

        log('Платный солвер требует реализации API клиента.');
        return null;
    } catch (e) {
        log('Ошибка платного солвера:', e);
        return null;
    }
}

export async function handleCaptcha(page, url) {
    const { detected, type } = await detectCaptcha(page);

    if (!detected) {
        log('Капча не обнаружена.');
        return true;
    }

    log(`Обнаружена капча типа: ${type}`);

    // 1. Пробуем бесплатно
    const freeSuccess = await tryFreeSolve(page);
    if (freeSuccess) {
        log('Капча решена бесплатно.');
        // Проверяем, исчезла ли капча
        const stillThere = await detectCaptcha(page);
        if (!stillThere.detected) return true;
    }

    // 2. Если бесплатно не вышло и настроен платный
    if (process.env.USE_PAID_SOLVER === 'true') {
        const paidSuccess = await tryPaidSolve(page, url);
        if (paidSuccess) return true;
    }

    // 3. Фоллбэк: долгое ожидание (вдруг пользователь решит руками, если headless: false)
    log('Автоматическое решение не удалось. Ожидание ручного вмешательства (60 сек)...');
    await wait(60000);

    // Финальная проверка
    const finalCheck = await detectCaptcha(page);
    return !finalCheck.detected;
}