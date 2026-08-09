#!/usr/bin/env node
/**
 * record-demo.js — автоматическая запись демо-роликов фич StackBid.
 *
 * Зачем это существует: 09.08 Игорь прямо сказал — никаких людей в процессе,
 * даже для скринкастов под видео-брифы. Раньше этот вопрос решался бы вручную
 * (кто-то заходит на сайт и записывает экран) — теперь это делает Playwright
 * сам, реальным браузером, с реальным сайтом, без притворства.
 *
 * Запуск (у Максима, с реальным доступом в интернет — из песочницы Claude
 * это не работает, сеть туда закрыта):
 *   cd stackbid-site/tools
 *   npm install playwright && npx playwright install chromium
 *   node record-demo.js
 *
 * Результат: videos/*.webm — реальная запись экрана 390x844 (портрет,
 * как в наших видео-брифах), готовая как исходник для видео-исполнителя.
 * Каждый сценарий — отдельный файл, monospace-именованный по фиче.
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const SITE = process.env.STACKBID_URL || 'https://stackbid.app';
const OUT_DIR = path.join(__dirname, 'videos');
const SAMPLE_PDF = path.join(__dirname, 'sample-contractor-quote.pdf');

fs.mkdirSync(OUT_DIR, { recursive: true });

async function withRecording(name, fn) {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, // как в реальных видео-брифах (портрет)
    recordVideo: { dir: OUT_DIR, size: { width: 390, height: 844 } },
  });
  const page = await context.newPage();
  console.log(`\n▶ Записываю: ${name}`);
  try {
    await fn(page);
  } catch (e) {
    console.error(`  ✗ Ошибка в сценарии "${name}":`, e.message);
  } finally {
    await context.close(); // видео сохраняется только здесь
    await browser.close();
    // Playwright даёт видео случайное имя — переименовываем во что-то понятное
    const files = fs.readdirSync(OUT_DIR).filter(f => f.endsWith('.webm') && !f.startsWith('sb-'));
    if (files.length) {
      const newName = `sb-${name}-${Date.now()}.webm`;
      fs.renameSync(path.join(OUT_DIR, files[0]), path.join(OUT_DIR, newName));
      console.log(`  ✓ Сохранено: videos/${newName}`);
    }
  }
}

async function scenarioAudit(page) {
  await page.goto(SITE);
  await page.waitForSelector('.tool-tab');
  // Кликаем по вкладке Audit (по тексту, устойчиво к верстке)
  await page.click('button.tool-tab:has-text("Audit")');
  await page.waitForTimeout(600); // естественная пауза для видео, не для логики
  await page.setInputFiles('#audit-fup', SAMPLE_PDF);
  await page.waitForTimeout(800);
  await page.click('#audit-btn');
  // Ждём реального ответа от /api/quote-audit, не таймаут вслепую
  await page.waitForSelector('#audit-out:not([style*="display:none"]) *', { timeout: 30000 });
  await page.waitForTimeout(2500); // задержаться на результате для видео
}

async function scenarioEstimateAndShare(page) {
  await page.goto(SITE);
  await page.waitForSelector('.ptype-btn');
  await page.click('button.ptype-btn:has-text("Deck")');
  await page.waitForTimeout(400);
  await page.fill('#desc', '20x24 ft composite deck, cable railing, single level');
  await page.fill('#zip', '90210');
  await page.click('#main-gen-btn');
  await page.waitForSelector('#etotals .totals, #total-local', { timeout: 30000 });
  await page.waitForTimeout(1500);
  const shareBtn = await page.$('#share-community-btn');
  if (shareBtn) {
    await shareBtn.click();
    await page.waitForTimeout(1200);
  }
}

async function scenarioRoiCallout(page) {
  await page.goto(SITE);
  await page.waitForSelector('.ptype-btn');
  await page.click('button.ptype-btn:has-text("Garage door")');
  await page.waitForSelector('#roi-callout:not([style*="display:none"])', { timeout: 5000 });
  await page.waitForTimeout(2000);
}

(async () => {
  if (!fs.existsSync(SAMPLE_PDF)) {
    console.error('Нет sample-contractor-quote.pdf рядом со скриптом — без него сценарий Audit пропущен.');
  }
  await withRecording('audit-tool', scenarioAudit);
  await withRecording('estimate-and-share', scenarioEstimateAndShare);
  await withRecording('roi-callout', scenarioRoiCallout);
  console.log('\nГотово. Все .webm-файлы — в tools/videos/, отдавать исполнителю напрямую.');
})();
