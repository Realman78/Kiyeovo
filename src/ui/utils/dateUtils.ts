// Bare HH:MM. 24h uses en-GB ("14:30"); 12h uses en-US for uppercase AM/PM ("02:30 PM").
export const formatTimestampToHourMinuteEu = (timestamp: number, hour12 = false) => {
    return new Date(timestamp).toLocaleTimeString(hour12 ? 'en-US' : 'en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        hour12,
    });
};

// Full, locale-aware date + time. `hour12` overrides the locale's clock convention.
export const formatFullDateTime = (timestamp: number, hour12 = false) => {
    return new Date(timestamp).toLocaleString(undefined, { hour12 });
};

// Compact date + time ("Mar 5, 2026, 02:30 PM"). Shared by the about/call modals.
export const formatDateTimeShort = (timestamp: number, hour12 = false) => {
    return new Date(timestamp).toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12,
    });
};

// Local-midnight Date for the day a timestamp falls in.
export const startOfDay = (timestamp: number): Date => {
    const d = new Date(timestamp);
    d.setHours(0, 0, 0, 0);
    return d;
};

// Whole calendar days between a timestamp's day and today (0 = today, 1 = yesterday, ...).
export const calendarDaysAgo = (timestamp: number, now: number = Date.now()): number => {
    const msPerDay = 24 * 60 * 60 * 1000;
    return Math.round((startOfDay(now).getTime() - startOfDay(timestamp).getTime()) / msPerDay);
};

// Shared tail for the WhatsApp-style relative labels below (only the "today"
// case differs between them): Yesterday / weekday (last 7 days) / locale date.
const formatRelativeDayBucket = (timestamp: number, daysAgo: number): string => {
    if (daysAgo === 1) return 'Yesterday';
    if (daysAgo < 7) return new Date(timestamp).toLocaleDateString(undefined, { weekday: 'long' });
    return new Date(timestamp).toLocaleDateString();
};

// Centered date-divider label for the message list: today → "Today".
export const formatDateDivider = (timestamp: number): string => {
    const daysAgo = calendarDaysAgo(timestamp);
    return daysAgo <= 0 ? 'Today' : formatRelativeDayBucket(timestamp, daysAgo);
};

// Last-message timestamp for the chat list: today → the time.
export const formatRelativeTimestamp = (timestamp: number, hour12 = false): string => {
    const daysAgo = calendarDaysAgo(timestamp);
    return daysAgo <= 0
        ? formatTimestampToHourMinuteEu(timestamp, hour12)
        : formatRelativeDayBucket(timestamp, daysAgo);
};
