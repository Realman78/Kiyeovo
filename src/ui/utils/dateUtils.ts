export const formatTimestampToHourMinuteEu = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });
};

// Full, locale-aware date + time
export const formatFullDateTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleString();
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
export const formatRelativeTimestamp = (timestamp: number): string => {
    const daysAgo = calendarDaysAgo(timestamp);
    return daysAgo <= 0
        ? formatTimestampToHourMinuteEu(timestamp)
        : formatRelativeDayBucket(timestamp, daysAgo);
};
