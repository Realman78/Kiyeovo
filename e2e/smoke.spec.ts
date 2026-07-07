import { test, expect } from '@playwright/test';
import { launchApp } from './electron';

test('app launches and renders the first window', async () => {
    const testInfo = test.info();
    const { page, close } = await launchApp();
    try {
        await page.waitForLoadState('domcontentloaded');
        await expect(page.locator('#root')).not.toBeEmpty();

        const screenshotPath = testInfo.outputPath('first-window.png');
        await page.screenshot({ path: screenshotPath });
        await testInfo.attach('first-window', { path: screenshotPath, contentType: 'image/png' });
    } finally {
        await close();
    }
});
