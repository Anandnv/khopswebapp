const { test, expect } = require("@playwright/test");

async function mockExternalScripts(page) {
  await page.route("**/config.js", async (route) => {
    await route.fulfill({
      contentType: "application/javascript; charset=utf-8",
      body: "window.KH_CONFIG = { supabaseUrl: '', supabaseAnonKey: '', enableDemoData: false };"
    });
  });

  await page.route("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2", async (route) => {
    await route.fulfill({
      contentType: "application/javascript; charset=utf-8",
      body: "window.supabase = undefined;"
    });
  });

  await page.route("https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js", async (route) => {
    await route.fulfill({
      contentType: "application/javascript; charset=utf-8",
      body: "window.html2canvas = async () => { throw new Error('html2canvas disabled in smoke tests'); };"
    });
  });

  await page.route("https://fonts.googleapis.com/**", (route) => route.fulfill({ status: 204, body: "" }));
  await page.route("https://fonts.gstatic.com/**", (route) => route.fulfill({ status: 204, body: "" }));
}

async function gotoApp(page) {
  await mockExternalScripts(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#loginScreen")).toBeVisible();
}

async function loginAsCentre(page, centreName = "Tirur") {
  await page.getByRole("button", { name: "Centre" }).click();
  await page.locator("#loginCentre").selectOption({ label: centreName });
  await page.locator("#loginPassword").fill("1234");
  await page.locator("#loginBtn").click();
  await expect(page.locator("#appShell")).toBeVisible();
  await expect(page.locator("#entryView")).toHaveClass(/active/);
}

async function loginAsAdmin(page) {
  await page.getByRole("button", { name: "Admin" }).click();
  await page.locator("#loginPassword").fill("admin123");
  await page.locator("#loginBtn").click();
  await expect(page.locator("#appShell")).toBeVisible();
  await expect(page.locator("#adminView")).toHaveClass(/active/);
}

test.beforeEach(async ({ page }) => {
  await gotoApp(page);
});

test("centre login opens the daily entry view", async ({ page }) => {
  await loginAsCentre(page);
  await expect(page.locator("#entryCentreName")).toContainText("Tirur");
  await expect(page.locator("#saveBtn")).toBeVisible();
});

test("centre daily entry saves to local storage", async ({ page }) => {
  await loginAsCentre(page);
  await page.locator("#opEntry input").first().fill("42");
  await page.locator("#saveBtn").click();
  await expect(page.locator("#toast")).toContainText(/saved/i);

  const stored = await page.evaluate(() => localStorage.getItem("kh-cardio-ops-state-v1"));
  expect(stored).toBeTruthy();

  const parsed = JSON.parse(stored);
  const date = await page.locator("#entryDate").inputValue();
  expect(parsed.entries["0"][date].op["Total OP"]).toBe(42);
});

test("past entry dates show the request edit access flow", async ({ page }) => {
  await loginAsCentre(page);
  const pastDate = await page.evaluate(() => {
    const date = new Date();
    date.setDate(date.getDate() - 2);
    return date.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  });
  await page.locator("#entryDate").fill(pastDate);
  await expect(page.locator("#entryLockBanner")).toContainText("Request Edit Access");
});

test("centre petty cash entries can be added", async ({ page }) => {
  await loginAsCentre(page);
  await page.locator('.nav-item[data-view="petty"]').click();
  await expect(page.locator("#pettyView")).toHaveClass(/active/);

  await page.locator("#pettyDate").fill(await page.locator("#entryDate").inputValue());
  await page.locator("#pettyParticulars").fill("Other Payments");
  await page.locator("#pettyPayments").fill("150");
  await page.locator("#pettyRemarks").fill("Smoke test entry");
  await page.locator("#pettySubmitBtn").click();

  await expect(page.locator("#toast")).toContainText(/petty entry saved/i);
  await expect(page.locator("#pettyRegisterTable tbody")).toContainText("Other Payments");
});

test("admin can open backup view and see backup status without crashing", async ({ page }) => {
  await loginAsAdmin(page);
  await page.locator('.nav-item[data-view="backup"]').click();
  await expect(page.locator("#backupView")).toHaveClass(/active/);
  await expect(page.locator("#backupList")).toContainText(/No database connection|No backups yet|Loading backups/i);
  await expect(page.locator("#reportDateInput")).toBeVisible();
});
