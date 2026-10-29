export const PAKISTAN_TIME_ZONE = "Asia/Karachi";

export function formatPakistanTime(instant) {
  const date = instant instanceof Date ? instant : new Date(instant || "");
  if (Number.isNaN(date.getTime())) return "";

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PAKISTAN_TIME_ZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h12",
  }).formatToParts(date);
  const part = type => parts.find(item => item.type === type)?.value || "";
  const dayPeriod = part("dayPeriod").replace(/[\u202F\u00A0.]/g, "").toUpperCase();

  return `${part("weekday")}, ${part("month")} ${part("day")}, ${part("year")} at ${part("hour")}:${part("minute")} ${dayPeriod} PKT`
    .replace(/[\u202F\u00A0]/g, " ");
}
