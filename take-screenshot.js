const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 }
  });

  console.log('Navigating to http://localhost:3001...');
  await page.goto('http://localhost:3001', { waitUntil: 'networkidle' });

  // ローディングが消えるのを待つ
  console.log('Waiting for load to complete...');
  await page.waitForSelector('h1:has-text("動画テロップ自動合成")');
  await page.waitForTimeout(2000); // UIが安定するまで少し待つ

  // 全体UIのスクショ
  console.log('Taking UI screenshot...');
  await page.screenshot({ path: '/Users/yudai/Antigravity/zenn-contents/images/browser-video-telop-generator/app_ui_mockup.png' });

  // テキストエリアに文字を入力してスクショ
  console.log('Entering text...');
  await page.fill('textarea', '実際のアプリ画面です。ブラウザ内でAI文字起こしから合成まで完了します。');
  await page.waitForTimeout(500);
  
  console.log('Taking text area screenshot...');
  await page.locator('.bg-blue-50').screenshot({ path: '/Users/yudai/Antigravity/zenn-contents/images/browser-video-telop-generator/transcription_progress.png' });

  await browser.close();
  console.log('Screenshots saved!');
})();
