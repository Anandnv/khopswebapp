(() => {
  function createReportControlTools(deps) {
    function getFilteredCenterIndexes() {
      if (deps.getCurrentRole() === "centre") return [deps.getLoggedInCentreIndex()];
      const assigned = deps.getAssignedCentreIndexes();
      const value = document.getElementById("exportCentre")?.value || "all";
      if (value === "all") return assigned;
      const idx = Number(value);
      return assigned.includes(idx) ? [idx] : assigned;
    }

    function getExportRange() {
      return {
        fromDate: document.getElementById("exportFromDate").value,
        toDate: document.getElementById("exportToDate").value
      };
    }

    function selectedReportType() {
      return document.getElementById("exportReportType")?.value || "consolidated";
    }

    function syncExportDatesToMonth(month) {
      const safeMonth = deps.resolveMonthOrFallback(month, deps.getReportDate());
      document.getElementById("exportFromDate").value = `${safeMonth}-01`;
      document.getElementById("exportToDate").value = deps.lastEntryDateForMonth(
        safeMonth,
        deps.getCenters(),
        deps.ensureCentreEntries,
        deps.todayIST()
      );
    }

    function renderAdminTrend(rows) {
      const chart = document.getElementById("adminTrendChart");
      const byDate = rows.reduce((acc, row) => {
        acc[row.date] = (acc[row.date] || 0) + row.intervention;
        return acc;
      }, {});
      const values = Object.entries(byDate);
      chart.innerHTML = "";
      if (!values.length) {
        chart.innerHTML = `<p>No saved data for this filter.</p>`;
        return;
      }
      const max = Math.max(...values.map(([, value]) => value), 1);
      values.forEach(([date, value]) => {
        const bar = document.createElement("div");
        bar.className = "trend-bar";
        bar.style.height = `${Math.max(12, (value / max) * 140)}px`;
        bar.title = `${deps.displayDate(date)}: ${value}`;
        bar.innerHTML = `<span>${date.slice(-2)}</span>`;
        chart.appendChild(bar);
      });
    }

    function renderAdminReportPreview() {
      if (deps.getActiveCompany() === "Swizton") {
        const chart = document.getElementById("adminTrendChart");
        if (chart) chart.innerHTML = `<p>No Swizton performance entries for this filter.</p>`;
        const forecast = document.getElementById("forecastCard");
        if (forecast) {
          forecast.innerHTML = `
            <span>Swizton Report Model</span>
            <strong>Leads & Advices</strong>
            <small>Swizton reporting follows the uploaded workbook format: Leads, OP seen, Advices, and Procedure Done split by UFE and Vericose.</small>
          `;
        }
        return;
      }

      const rows = deps.filteredDailyRows();
      const forecast = deps.reportForecast(rows);
      renderAdminTrend(rows);
      document.getElementById("forecastCard").innerHTML = `
        <span>Projected Intervention</span>
        <strong>${forecast.projected}</strong>
        <small>${forecast.projectedAchievement}% projected achievement against target ${forecast.selectedTarget}. Required run rate: ${forecast.requiredPerDay.toFixed(1)} per remaining day. Use CSV / Excel for raw data, Professional PDF for management presentation.</small>
      `;
    }

    function setupMonthSelect() {
      const monthSelect = document.getElementById("monthSelect");
      monthSelect.addEventListener("change", () => {
        const selectedMonth = monthSelect.value;
        if (!selectedMonth) return;
        const newReportDate = deps.lastEntryDateForMonth(
          selectedMonth,
          deps.getCenters(),
          deps.ensureCentreEntries,
          deps.todayIST()
        );
        deps.setReportDate(newReportDate);
        if (!deps.getSwiztonEditingId() && document.getElementById("swiztonMonth")) {
          document.getElementById("swiztonMonth").value = selectedMonth;
        }
        document.getElementById("exportMonth").value = selectedMonth;
        syncExportDatesToMonth(selectedMonth);
        deps.refreshCenterRollups(deps.getReportDate());
        deps.renderConsolidated();
        deps.renderBars();
        deps.renderPayerSplit();
        deps.renderTargets();
        renderAdminReportPreview();
        const adminPettyMonth = document.getElementById("adminPettyMonth");
        if (adminPettyMonth) adminPettyMonth.value = selectedMonth;
        if (document.getElementById("centreView").classList.contains("active")) {
          deps.openCentre(deps.getActiveCentreDashboardIndex(), deps.getActiveCentreDetailTab());
        }
      });
    }

    function setupExportFilters() {
      deps.refreshCenterLists();
      document.getElementById("exportMonth").addEventListener("change", (event) => {
        if (!event.target.value) return;
        syncExportDatesToMonth(event.target.value);
        renderAdminReportPreview();
      });
      ["exportCentre", "exportReportType", "exportFromDate", "exportToDate"].forEach((id) => {
        document.getElementById(id).addEventListener("change", renderAdminReportPreview);
      });
    }

    function setupExportMenus() {
      document.querySelectorAll(".export-menu-button").forEach((button) => {
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          const dropdown = button.nextElementSibling;
          document.querySelectorAll(".export-dropdown").forEach((menu) => {
            if (menu !== dropdown) menu.classList.add("hidden");
          });
          dropdown.classList.toggle("hidden");
        });
      });

      document.querySelectorAll("[data-export-format]").forEach((button) => {
        button.addEventListener("click", () => {
          document.querySelectorAll(".export-dropdown").forEach((menu) => menu.classList.add("hidden"));
          const format = button.dataset.exportFormat;
          if (format === "pdf") deps.downloadProfessionalReport();
          if (format === "csv") deps.downloadFilteredCsvReport();
          if (format === "png") deps.downloadImageReport("png");
          if (format === "jpg") deps.downloadImageReport("jpg");
        });
      });

      document.addEventListener("click", () => {
        document.querySelectorAll(".export-dropdown").forEach((menu) => menu.classList.add("hidden"));
      });
    }

    return {
      getExportRange,
      getFilteredCenterIndexes,
      renderAdminReportPreview,
      selectedReportType,
      setupExportFilters,
      setupExportMenus,
      setupMonthSelect,
      syncExportDatesToMonth
    };
  }

  window.KHReportControls = { createReportControlTools };
})();
