import { test, expect } from '@playwright/test';
import { spawn } from 'child_process';
import path from 'path';
import http from 'http';

function waitForServer(url: string, timeoutMs = 10000) {
  const start = Date.now();
  return new Promise<void>((resolve, reject) => {
    const check = () => {
      http.get(url, res => {
        resolve();
      }).on('error', () => {
        if (Date.now() - start > timeoutMs) return reject(new Error('server not ready'));
        setTimeout(check, 300);
      });
    };
    check();
  });
}

async function isListening(url: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const req = http.get(url, () => resolve(true));
    req.on('error', () => resolve(false));
  });
}

async function navigateWithRetry(page: any, url: string, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      return;
    } catch (e) {
      console.warn(`[e2e] goto failed (attempt ${i + 1}/${attempts})`, e + '');
      await new Promise(r => setTimeout(r, 500));
    }
  }
  // Final try to bubble actual error
  await page.goto(url, { waitUntil: 'domcontentloaded' });
}

test.describe('Affection e2e', () => {
  let signalProc: any;
  let staticProc: any;
  const STATIC_PORT = process.env.STATIC_PORT || '5510';

  test.beforeAll(async () => {
    const cwd = path.resolve(__dirname, '..');
    // Start signaling only if not already listening
    if (!(await isListening('http://localhost:3000/socket.io/?EIO=4&transport=polling'))) {
      console.log('[e2e] starting signaling server on 3000');
      signalProc = spawn('node', ['server.js'], { cwd, stdio: 'inherit' });
      await waitForServer('http://localhost:3000/socket.io/?EIO=4&transport=polling');
    }
    // Start static server only if not already listening
    if (!(await isListening(`http://localhost:${STATIC_PORT}`))) {
      console.log(`[e2e] starting static server on ${STATIC_PORT}`);
      staticProc = spawn('npx', ['http-server', '-p', STATIC_PORT, '.'], { cwd, stdio: 'inherit', shell: true });
      await waitForServer(`http://localhost:${STATIC_PORT}`);
      // Grace period for server warm-up
      await new Promise(r => setTimeout(r, 250));
    }
  });

  test.afterAll(async () => {
    if (signalProc) signalProc.kill('SIGKILL');
    if (staticProc) staticProc.kill('SIGKILL');
  });

  test('two tabs connect and show remote stream', async ({ browser }) => {
    const context = await browser.newContext({ permissions: ['microphone', 'camera'] });
    const page1 = await context.newPage();
    const page2 = await context.newPage();
    await navigateWithRetry(page1, `http://localhost:${STATIC_PORT}/#room-e2e`);
    await navigateWithRetry(page2, `http://localhost:${STATIC_PORT}/#room-e2e`);

    await page1.getByRole('button', { name: 'Start', exact: true }).click();
    // Wait for status to show Connected on at least one page
    await expect(page1.locator('#statusText')).toHaveText(/Connected|Calling|Requesting/);

    // Give time for negotiation; assert that remote video has attached srcObject
    await page2.waitForTimeout(3000);
    const hasRemote = await page2.evaluate(() => {
      const v = document.getElementById('remoteVideo') as HTMLVideoElement;
      return !!(v && (v as any).srcObject);
    });
    expect(hasRemote).toBeTruthy();

    // Toggle mute and video
    await page1.getByRole('button', { name: /Mute|Unmute/ }).click();
    await page1.getByRole('button', { name: /Video Off|Video On/ }).click();

    // Restart ICE should re-negotiate without throwing
    await page1.getByRole('button', { name: 'Restart ICE' }).click();
    await page1.waitForTimeout(1000);
  });

  test('glare handling: ignore unexpected answers', async ({ browser }) => {
    const context = await browser.newContext({ permissions: ['microphone', 'camera'] });
    const a = await context.newPage();
    const b = await context.newPage();
    await navigateWithRetry(a, `http://localhost:${STATIC_PORT}/#room-glare`);
    await navigateWithRetry(b, `http://localhost:${STATIC_PORT}/#room-glare`);

    await Promise.all([
      a.getByRole('button', { name: 'Start', exact: true }).click(),
      b.getByRole('button', { name: 'Start', exact: true }).click()
    ]);

    await a.waitForTimeout(3000);
    const attached = await a.evaluate(() => !!(document.getElementById('remoteVideo') as HTMLVideoElement)?.srcObject);
    expect(attached).toBeTruthy();
  });
});


