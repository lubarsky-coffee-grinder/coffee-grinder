import { sleep } from './sleep.js'; // Используйте вашу существующую функцию или реализуйте ниже

// Простая реализация sleep, если нет отдельного файла
export const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Случайное число в диапазоне
export const random = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// Эмуляция движения мыши человека (кривые Безье)
export async function humanMove(page, startX, startY, endX, endY) {
    const steps = random(10, 30);
    const duration = random(500, 1500);

    let x = startX;
    let y = startY;

    for (let i = 1; i <= steps; i++) {
        const progress = i / steps;
        // Добавляем немного случайности в траекторию
        const noiseX = (Math.random() - 0.5) * 20;
        const noiseY = (Math.random() - 0.5) * 20;

        const curX = startX + (endX - startX) * progress + noiseX;
        const curY = startY + (endY - startY) * progress + noiseY;

        await page.mouse.move(curX, curY);
        await wait(duration / steps);
    }
    await page.mouse.move(endX, endY);
}

// Эмуляция клика человека
export async function humanClick(page, selector) {
    const element = await page.$(selector);
    if (!element) return false;

    const box = await element.boundingBox();
    if (!box) return false;

    // Двигаем мышь к элементу
    await humanMove(
        page,
        random(100, 500), random(100, 500), // Откуда (случайно)
        box.x + box.width / 2, box.y + box.height / 2 // Куда (центр элемента)
    );

    await wait(random(100, 300)); // Пауза перед кликом
    await page.mouse.down();
    await wait(random(50, 150)); // Длительность нажатия
    await page.mouse.up();

    return true;
}