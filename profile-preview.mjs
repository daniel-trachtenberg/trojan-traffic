import { chromium, devices } from "playwright";

async function captureDesktop() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1500, height: 1180 },
    colorScheme: "dark"
  });

  await page.goto("http://127.0.0.1:3001", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open sign in panel" }).click();
  await page.waitForSelector(".account-modal");

  const modal = page.locator(".account-modal");
  await modal.screenshot({ path: "/tmp/trojan-traffic-profile-desktop-top.png" });

  await page.locator(".center-modal-body").evaluate((element) => {
    element.scrollTo({ top: element.scrollHeight * 0.44, behavior: "instant" });
  });
  await page.waitForTimeout(250);
  await modal.screenshot({ path: "/tmp/trojan-traffic-profile-desktop-settings.png" });

  await browser.close();
}

async function captureMobile() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ...devices["iPhone 14"],
    colorScheme: "dark"
  });
  const page = await context.newPage();

  await page.goto("http://127.0.0.1:3001", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open sign in panel" }).click();
  await page.waitForSelector(".account-modal");

  await page.screenshot({ path: "/tmp/trojan-traffic-profile-mobile.png", fullPage: true });
  await browser.close();
}

await captureDesktop();
await captureMobile();
