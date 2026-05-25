(() => {
  function createAuthSessionTools(deps) {
    const SESSION_KEY = "kh-session-v1";
    const LOCKOUT_KEY = "kh-lockout-v1";
    const MAX_ATTEMPTS = 5;
    const LOCKOUT_MS = 30_000;

    async function sha256(text) {
      const buffer = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(text)
      );
      return Array.from(new Uint8Array(buffer))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    }

    function getLockout() {
      try {
        return JSON.parse(sessionStorage.getItem(LOCKOUT_KEY) || "{}");
      } catch {
        return {};
      }
    }

    function saveLockout(data) {
      sessionStorage.setItem(LOCKOUT_KEY, JSON.stringify(data));
    }

    function lockoutSecondsLeft() {
      const { until = 0 } = getLockout();
      return Math.max(0, Math.ceil((until - Date.now()) / 1000));
    }

    function recordFailedAttempt() {
      const lock = getLockout();
      lock.attempts = (lock.attempts || 0) + 1;
      if (lock.attempts >= MAX_ATTEMPTS) {
        lock.until = Date.now() + LOCKOUT_MS;
        lock.attempts = 0;
      }
      saveLockout(lock);
    }

    function resetAttempts() {
      saveLockout({});
    }

    function saveSession(role, centreIndex, adminIndex = -1) {
      sessionStorage.setItem(
        SESSION_KEY,
        JSON.stringify({ role, centreIndex, adminIndex, ts: Date.now() })
      );
    }

    function clearSession() {
      sessionStorage.removeItem(SESSION_KEY);
    }

    function loadSession() {
      try {
        return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
      } catch {
        return null;
      }
    }

    async function login() {
      const error = document.getElementById("loginError");
      const wait = lockoutSecondsLeft();
      if (wait > 0) {
        error.textContent = `Too many failed attempts. Try again in ${wait}s.`;
        return;
      }

      const passwordRaw = document.getElementById("loginPassword").value;
      if (!passwordRaw) {
        error.textContent = "Please enter a password.";
        return;
      }

      const passwordHash = await sha256(passwordRaw);
      const centreIndex = Number(document.getElementById("loginCentre").value);
      error.textContent = "";

      if (deps.getLoginType() === "superadmin") {
        const superHash = deps.config.superAdminPasswordHash || await sha256("superadmin123");
        if (passwordHash !== superHash) {
          recordFailedAttempt();
          const remaining = lockoutSecondsLeft();
          error.textContent = remaining > 0
            ? `Too many failed attempts. Locked for ${remaining}s.`
            : "Invalid super admin password.";
          return;
        }
        resetAttempts();
        saveSession("superadmin", -1, -1);
        document.getElementById("loginScreen").classList.add("hidden");
        document.getElementById("appShell").classList.remove("hidden");
        deps.setRole("superadmin");
        return;
      }

      if (deps.getLoginType() === "admin") {
        const adminUsername = document.getElementById("loginAdminUsername")?.value?.trim() || "";
        const hiddenSuperHash = deps.config.superAdminPasswordHash;
        const hiddenSuperUser = deps.config.superAdminUsername;
        if (hiddenSuperHash && hiddenSuperUser && adminUsername === hiddenSuperUser && passwordHash === hiddenSuperHash) {
          resetAttempts();
          saveSession("superadmin", -1, -1);
          document.getElementById("loginScreen").classList.add("hidden");
          document.getElementById("appShell").classList.remove("hidden");
          deps.setRole("superadmin");
          return;
        }

        const admins = deps.getAdmins();
        const matchedAdminIdx = admins.findIndex((admin) => admin.username === adminUsername);
        if (matchedAdminIdx >= 0) {
          const admin = admins[matchedAdminIdx];
          const storedHash = admin.passwordHash || await sha256(admin.password || "");
          if (passwordHash !== storedHash) {
            recordFailedAttempt();
            const remaining = lockoutSecondsLeft();
            error.textContent = remaining > 0
              ? `Too many failed attempts. Locked for ${remaining}s.`
              : "Invalid admin password.";
            return;
          }
          resetAttempts();
          saveSession("admin", -1, matchedAdminIdx);
          document.getElementById("loginScreen").classList.add("hidden");
          document.getElementById("appShell").classList.remove("hidden");
          deps.setRole("admin", -1, matchedAdminIdx);
          return;
        }

        const adminHash = deps.config.adminPasswordHash || await sha256("admin123");
        if (passwordHash !== adminHash) {
          recordFailedAttempt();
          const remaining = lockoutSecondsLeft();
          error.textContent = remaining > 0
            ? `Too many failed attempts. Locked for ${remaining}s.`
            : "Invalid admin credentials.";
          return;
        }
        resetAttempts();
        saveSession("admin", -1, -1);
        document.getElementById("loginScreen").classList.add("hidden");
        document.getElementById("appShell").classList.remove("hidden");
        deps.setRole("admin", -1, -1);
        return;
      }

      const centre = deps.getCenters()[centreIndex];
      const storedCredential = centre.passwordHash || await sha256(centre.password || "");
      if (passwordHash !== storedCredential) {
        recordFailedAttempt();
        const remaining = lockoutSecondsLeft();
        error.textContent = remaining > 0
          ? `Too many failed attempts. Locked for ${remaining}s.`
          : "Invalid centre password.";
        return;
      }

      resetAttempts();
      saveSession("centre", centreIndex);
      document.getElementById("loginScreen").classList.add("hidden");
      document.getElementById("appShell").classList.remove("hidden");
      deps.setRole("centre", centreIndex);
    }

    function logout() {
      clearSession();
      document.getElementById("appShell").classList.add("hidden");
      document.getElementById("loginScreen").classList.remove("hidden");
      document.getElementById("loginPassword").value = "";
      document.getElementById("loginError").textContent = "";
    }

    function setupLogin() {
      const centreSelect = document.getElementById("loginCentre");
      centreSelect.innerHTML = deps.getCenters()
        .map((center, index) => ({ center, index }))
        .filter(({ center }) => (center.company || "KH") === "KH")
        .map(({ center, index }) => `<option value="${index}">${center.name}</option>`)
        .join("");

      setInterval(() => {
        const secs = lockoutSecondsLeft();
        const el = document.getElementById("loginLockout");
        const btn = document.getElementById("loginBtn");
        if (!el) return;
        if (secs > 0) {
          el.textContent = `Login locked — too many failed attempts. Try again in ${secs}s.`;
          el.classList.remove("hidden");
          btn.disabled = true;
        } else {
          el.classList.add("hidden");
          btn.disabled = false;
        }
      }, 500);

      document.querySelectorAll(".login-tab").forEach((tab) => {
        tab.addEventListener("click", () => {
          deps.setLoginType(tab.dataset.loginType);
          document.querySelectorAll(".login-tab").forEach((item) => item.classList.toggle("active", item === tab));
          document.querySelector(".centre-login-field").classList.toggle("hidden", deps.getLoginType() !== "centre");
          document.querySelector(".admin-login-field").classList.toggle("hidden", deps.getLoginType() !== "admin");
          document.getElementById("loginPassword").value = "";
          document.getElementById("loginError").textContent = "";
        });
      });

      document.getElementById("loginBtn").addEventListener("click", () => login());
      document.getElementById("loginPassword").addEventListener("keydown", (event) => {
        if (event.key === "Enter") login();
      });
      document.getElementById("logoutBtn").addEventListener("click", logout);
    }

    return {
      clearSession,
      loadSession,
      lockoutSecondsLeft,
      login,
      logout,
      recordFailedAttempt,
      resetAttempts,
      saveSession,
      setupLogin,
      sha256
    };
  }

  window.KHAuthSession = { createAuthSessionTools };
})();
