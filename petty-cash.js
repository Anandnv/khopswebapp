(() => {
  function createPettyCashTools(deps) {
    function ensurePettyCentre(centreIndex) {
      const store = deps.normalizePettyCash(deps.getPettyCash());
      if (!store.balances[centreIndex]) store.balances[centreIndex] = {};
      if (!Array.isArray(store.entries[centreIndex])) store.entries[centreIndex] = [];
      deps.setPettyCash(store);
      return store.entries[centreIndex];
    }

    function selectedPettyMonth() {
      return document.getElementById("pettyMonth")?.value || deps.todayIST().slice(0, 7);
    }

    function selectedAdminPettyMonth() {
      return document.getElementById("adminPettyMonth")?.value || document.getElementById("monthSelect")?.value || deps.getReportDate().slice(0, 7);
    }

    function getPettyOpeningBalance(centreIndex, month) {
      ensurePettyCentre(centreIndex);
      return deps.currencySafeNumber(deps.getPettyCash().balances[centreIndex]?.[month]);
    }

    function setPettyOpeningBalance(centreIndex, month, amount) {
      ensurePettyCentre(centreIndex);
      const store = deps.getPettyCash();
      store.balances[centreIndex][month] = deps.currencySafeNumber(amount);
    }

    function getPettyEntries(centreIndex, month = "") {
      return ensurePettyCentre(centreIndex)
        .filter((entry) => !month || (entry.date || "").slice(0, 7) === month)
        .sort((a, b) =>
          (a.date || "").localeCompare(b.date || "") ||
          (a.createdAt || "").localeCompare(b.createdAt || "") ||
          String(a.id).localeCompare(String(b.id))
        );
    }

    function pettyRegisterRows(centreIndex, month) {
      const rows = [];
      let balance = getPettyOpeningBalance(centreIndex, month);
      rows.push({
        slNo: 1,
        date: "",
        particulars: "Opening Balance",
        voucherNo: "",
        receipts: 0,
        payments: 0,
        balance,
        remarks: "",
        isOpening: true
      });
      getPettyEntries(centreIndex, month).forEach((entry, index) => {
        const receipts = deps.currencySafeNumber(entry.receipts);
        const payments = deps.currencySafeNumber(entry.payments);
        balance += receipts - payments;
        rows.push({
          ...entry,
          slNo: index + 2,
          receipts,
          payments,
          balance
        });
      });
      return rows;
    }

    function pettyTotals(centreIndex, month) {
      const entriesForMonth = getPettyEntries(centreIndex, month);
      const opening = getPettyOpeningBalance(centreIndex, month);
      const receipts = entriesForMonth.reduce((sum, entry) => sum + deps.currencySafeNumber(entry.receipts), 0);
      const payments = entriesForMonth.reduce((sum, entry) => sum + deps.currencySafeNumber(entry.payments), 0);
      return {
        opening,
        receipts,
        payments,
        closing: opening + receipts - payments,
        count: entriesForMonth.length
      };
    }

    function formatPettyAmount(value, blankZero = true) {
      const amount = deps.currencySafeNumber(value);
      if (blankZero && amount === 0) return "";
      return amount.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function renderPettyParticularOptions() {
      document.querySelectorAll("[data-petty-particular-options]").forEach((list) => {
        list.innerHTML = deps.pettyParticularOptions
          .map((option) => `<option value="${deps.escapeHtml(option)}"></option>`)
          .join("");
      });
    }

    function renderPettySummary(summaryId, centreIndex, month) {
      const summary = document.getElementById(summaryId);
      if (!summary) return;
      const totals = pettyTotals(centreIndex, month);
      summary.innerHTML = `
        <div><span>Opening Balance</span><strong>${formatPettyAmount(totals.opening, false)}</strong></div>
        <div><span>Receipts</span><strong>${formatPettyAmount(totals.receipts, false)}</strong></div>
        <div><span>Total Expense</span><strong>${formatPettyAmount(totals.payments, false)}</strong></div>
        <div><span>Closing Balance</span><strong>${formatPettyAmount(totals.closing, false)}</strong></div>
      `;
    }

    function renderPettyRegister(tableId, centreIndex, month, options = {}) {
      const table = document.getElementById(tableId);
      if (!table || !deps.getCenters()[centreIndex]) return;
      const editable = options.editable === true;
      const tbody = table.querySelector("tbody");
      const tfoot = table.querySelector("tfoot");
      const rows = pettyRegisterRows(centreIndex, month);
      tbody.innerHTML = rows.map((row) => {
        const actionCell = editable
          ? row.isOpening
            ? `<td class="petty-actions-cell"></td>`
            : `<td class="petty-actions-cell">
                <button class="text-button" type="button" data-petty-edit="${row.id}">Edit</button>
                <button class="text-button danger" type="button" data-petty-delete="${row.id}">Delete</button>
              </td>`
          : "";
        return `
          <tr class="${row.isOpening ? "petty-opening-row" : ""}">
            <td>${row.slNo}</td>
            <td>${row.date ? deps.displayDate(row.date) : ""}</td>
            <td>${deps.escapeHtml(row.particulars || "")}</td>
            <td>${deps.escapeHtml(row.voucherNo || "")}</td>
            <td class="petty-amount">${formatPettyAmount(row.receipts)}</td>
            <td class="petty-amount">${formatPettyAmount(row.payments)}</td>
            <td class="petty-amount">${formatPettyAmount(row.balance, false)}</td>
            <td>${deps.escapeHtml(row.remarks || "")}</td>
            ${actionCell}
          </tr>
        `;
      }).join("");

      const totals = pettyTotals(centreIndex, month);
      const colspan = editable ? 5 : 5;
      tfoot.innerHTML = `
        <tr>
          <td colspan="${colspan}">Total expense</td>
          <td class="petty-amount">${formatPettyAmount(totals.payments, false)}</td>
          <td></td>
          <td></td>
          ${editable ? "<td></td>" : ""}
        </tr>
      `;

      if (options.summaryId) renderPettySummary(options.summaryId, centreIndex, month);

      if (editable) {
        tbody.querySelectorAll("[data-petty-edit]").forEach((button) => {
          button.addEventListener("click", () => editPettyEntry(button.dataset.pettyEdit));
        });
        tbody.querySelectorAll("[data-petty-delete]").forEach((button) => {
          button.addEventListener("click", () => deletePettyEntry(button.dataset.pettyDelete));
        });
      }
    }

    function renderPettyCashForCentre() {
      if (deps.getCurrentRole() !== "centre") return;
      const centreIndex = deps.getLoggedInCentreIndex();
      const centre = deps.getCenters()[centreIndex];
      if (!centre) return;
      const monthInput = document.getElementById("pettyMonth");
      const month = monthInput?.value || deps.todayIST().slice(0, 7);
      if (monthInput && !monthInput.value) monthInput.value = month;
      const dateInput = document.getElementById("pettyDate");
      if (dateInput && !dateInput.value) dateInput.value = deps.todayIST();
      document.getElementById("pettyCentreName").textContent = `${centre.name} Petty Cash`;
      document.getElementById("pettyLockedCentreName").textContent = centre.name;
      const balanceInput = document.getElementById("pettyOpeningBalance");
      if (balanceInput && document.activeElement !== balanceInput) {
        balanceInput.value = getPettyOpeningBalance(centreIndex, month);
      }
      renderPettyRegister("pettyRegisterTable", centreIndex, month, {
        editable: true,
        summaryId: "pettySummary"
      });
    }

    function renderCentrePettyDetail() {
      const centreIndex = deps.getActiveCentreDashboardIndex();
      const centre = deps.getCenters()[centreIndex];
      if (!centre) return;
      const monthInput = document.getElementById("adminPettyMonth");
      const month = monthInput?.value || document.getElementById("monthSelect")?.value || deps.getReportDate().slice(0, 7);
      if (monthInput && !monthInput.value) monthInput.value = month;
      document.getElementById("adminPettyCentreName").textContent = `${centre.name} Petty Cash`;
      renderPettyRegister("adminPettyRegisterTable", centreIndex, month, {
        editable: false,
        summaryId: "adminPettySummary"
      });
    }

    function resetPettyForm(resetDate = false) {
      deps.setPettyEditingId(null);
      const idInput = document.getElementById("pettyEntryId");
      if (idInput) idInput.value = "";
      document.getElementById("pettyFormTitle").textContent = "Add Petty Entry";
      document.getElementById("pettySubmitBtn").textContent = "Add Entry";
      document.getElementById("pettyCancelEditBtn").classList.add("hidden");
      if (resetDate) document.getElementById("pettyDate").value = deps.todayIST();
      ["pettyParticulars", "pettyVoucherNo", "pettyReceipts", "pettyPayments", "pettyRemarks"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = "";
      });
    }

    function savePettyOpeningBalance() {
      if (deps.getCurrentRole() !== "centre") {
        deps.showToast("Admins can view petty cash, but only centres can enter it.");
        return;
      }
      const month = selectedPettyMonth();
      const amount = deps.currencySafeNumber(document.getElementById("pettyOpeningBalance").value);
      setPettyOpeningBalance(deps.getLoggedInCentreIndex(), month, amount);
      deps.persistSoon();
      renderPettyCashForCentre();
      deps.showToast("Opening balance saved");
    }

    function savePettyEntry() {
      if (deps.getCurrentRole() !== "centre") {
        deps.showToast("Admins can view petty cash, but only centres can enter it.");
        return;
      }
      const date = document.getElementById("pettyDate").value;
      const particulars = document.getElementById("pettyParticulars").value.trim();
      const voucherNo = document.getElementById("pettyVoucherNo").value.trim();
      const receipts = deps.currencySafeNumber(document.getElementById("pettyReceipts").value);
      const payments = deps.currencySafeNumber(document.getElementById("pettyPayments").value);
      const remarks = document.getElementById("pettyRemarks").value.trim();

      if (!date || !particulars) {
        deps.showToast("Enter the date and particulars.");
        return;
      }
      if (receipts < 0 || payments < 0) {
        deps.showToast("Receipts and payments cannot be negative.");
        return;
      }
      if (receipts > 0 && payments > 0) {
        deps.showToast("Use either receipts or payments for one row, not both.");
        return;
      }
      if (receipts === 0 && payments === 0) {
        deps.showToast("Enter a receipt or payment amount.");
        return;
      }

      const month = date.slice(0, 7);
      const monthInput = document.getElementById("pettyMonth");
      if (monthInput && monthInput.value !== month) monthInput.value = month;
      const centreIndex = deps.getLoggedInCentreIndex();
      const entriesForCentre = ensurePettyCentre(centreIndex);
      const payload = {
        date,
        particulars,
        voucherNo,
        receipts,
        payments,
        remarks,
        updatedAt: new Date().toISOString(),
        updatedBy: deps.getCenters()[centreIndex]?.name || "Centre"
      };

      if (deps.getPettyEditingId()) {
        const existing = entriesForCentre.find((entry) => String(entry.id) === String(deps.getPettyEditingId()));
        if (existing) Object.assign(existing, payload);
      } else {
        entriesForCentre.push({
          id: `${Date.now()}-${Math.floor(Math.random() * 1000)}`,
          ...payload,
          createdAt: new Date().toISOString()
        });
      }

      deps.persistSoon();
      resetPettyForm(false);
      renderPettyCashForCentre();
      deps.showToast("Petty entry saved");
    }

    function editPettyEntry(entryId) {
      const entry = ensurePettyCentre(deps.getLoggedInCentreIndex()).find((item) => String(item.id) === String(entryId));
      if (!entry) return;
      deps.setPettyEditingId(entry.id);
      document.getElementById("pettyEntryId").value = entry.id;
      document.getElementById("pettyFormTitle").textContent = "Edit Petty Entry";
      document.getElementById("pettySubmitBtn").textContent = "Update Entry";
      document.getElementById("pettyCancelEditBtn").classList.remove("hidden");
      document.getElementById("pettyMonth").value = (entry.date || deps.todayIST()).slice(0, 7);
      document.getElementById("pettyDate").value = entry.date || deps.todayIST();
      document.getElementById("pettyParticulars").value = entry.particulars || "";
      document.getElementById("pettyVoucherNo").value = entry.voucherNo || "";
      document.getElementById("pettyReceipts").value = entry.receipts || "";
      document.getElementById("pettyPayments").value = entry.payments || "";
      document.getElementById("pettyRemarks").value = entry.remarks || "";
      renderPettyCashForCentre();
    }

    function deletePettyEntry(entryId) {
      const ok = window.confirm("Delete this petty cash entry?");
      if (!ok) return;
      const centreIndex = deps.getLoggedInCentreIndex();
      const entriesForCentre = ensurePettyCentre(centreIndex);
      deps.getPettyCash().entries[centreIndex] = entriesForCentre.filter((entry) => String(entry.id) !== String(entryId));
      if (String(deps.getPettyEditingId()) === String(entryId)) resetPettyForm(false);
      deps.saveConfig().catch((error) => {
        console.error("adminSaveEntry config sync failed:", error);
      });
      renderPettyCashForCentre();
      deps.showToast("Petty entry deleted");
    }

    function setupPettyControls() {
      renderPettyParticularOptions();
      document.getElementById("pettyMonth")?.addEventListener("change", () => {
        resetPettyForm(false);
        renderPettyCashForCentre();
      });
      document.getElementById("pettyOpeningBalance")?.addEventListener("keydown", (event) => {
        if (event.key === "Enter") savePettyOpeningBalance();
      });
      document.getElementById("pettySaveBalanceBtn")?.addEventListener("click", savePettyOpeningBalance);
      document.getElementById("pettySubmitBtn")?.addEventListener("click", savePettyEntry);
      document.getElementById("pettyCancelEditBtn")?.addEventListener("click", () => {
        resetPettyForm(true);
        renderPettyCashForCentre();
      });
      document.getElementById("pettyDownloadBtn")?.addEventListener("click", () => {
        deps.downloadPettyCashReport(deps.getLoggedInCentreIndex(), selectedPettyMonth());
      });
      document.getElementById("adminPettyMonth")?.addEventListener("change", renderCentrePettyDetail);
      document.getElementById("adminPettyDownloadBtn")?.addEventListener("click", () => {
        deps.downloadPettyCashReport(deps.getActiveCentreDashboardIndex(), selectedAdminPettyMonth());
      });
    }

    return {
      ensurePettyCentre,
      formatPettyAmount,
      getPettyEntries,
      getPettyOpeningBalance,
      pettyRegisterRows,
      pettyTotals,
      renderCentrePettyDetail,
      renderPettyCashForCentre,
      selectedAdminPettyMonth,
      selectedPettyMonth,
      setPettyOpeningBalance,
      setupPettyControls
    };
  }

  window.KHPettyCash = { createPettyCashTools };
})();
