(() => {
  const IST_TIME_ZONE = "Asia/Kolkata";

  /**
   * Return a stable YYYY-MM-DD calendar date in India time.
   * Using formatToParts avoids depending on a browser's en-CA date layout.
   */
  function dateInIST(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: IST_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    const values = Object.fromEntries(
      parts.filter(({ type }) => type !== "literal").map(({ type, value }) => [type, value])
    );
    return `${values.year}-${values.month}-${values.day}`;
  }

  function todayIST() {
    return dateInIST();
  }

  function getYesterdayIST() {
    const [year, month, day] = todayIST().split("-").map(Number);
    const yesterday = new Date(Date.UTC(year, month - 1, day - 1));
    return yesterday.toISOString().slice(0, 10);
  }

  function getMonthEndDate(dateStr) {
    const date = new Date(`${dateStr}T00:00:00`);
    const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0);
    return lastDay.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  }

  function monthKey(value) {
    return String(value || "").slice(0, 7);
  }

  function monthLabel(month) {
    if (!month) return "";
    const date = new Date(`${month}-01T00:00:00`);
    return date.toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "Asia/Kolkata"
    });
  }

  function displayDate(date) {
    const [year, month, day] = String(date || "").split("-");
    return year && month && day ? `${day}-${month}-${year}` : String(date || "");
  }

  function resolveMonthOrFallback(month, fallbackDate = todayIST()) {
    return /^\d{4}-\d{2}$/.test(month || "")
      ? month
      : (monthKey(fallbackDate) || todayIST().slice(0, 7));
  }

  function lastEntryDateForMonth(month, centers, getCentreEntries, fallbackDate = todayIST()) {
    const safeMonth = resolveMonthOrFallback(month, fallbackDate);
    let latest = "";

    centers.forEach((_, index) => {
      const centreEntries = getCentreEntries(index);
      Object.keys(centreEntries)
        .filter((date) => date.slice(0, 7) === safeMonth)
        .forEach((date) => {
          if (date > latest) latest = date;
        });
    });

    if (!latest) {
      if (monthKey(fallbackDate) === safeMonth) return fallbackDate;
      return getMonthEndDate(`${safeMonth}-01`);
    }

    return latest;
  }

  window.KHReportDateUtils = {
    dateInIST,
    displayDate,
    getMonthEndDate,
    getYesterdayIST,
    lastEntryDateForMonth,
    monthKey,
    monthLabel,
    resolveMonthOrFallback,
    todayIST
  };
})();
