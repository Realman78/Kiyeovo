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

// Centered date-divider label for the message list (WhatsApp-style):
// Today / Yesterday / weekday (last 7 days) / locale date (older).
export const formatDateDivider = (timestamp: number): string => {
    const daysAgo = calendarDaysAgo(timestamp);
    if (daysAgo <= 0) return 'Today';
    if (daysAgo === 1) return 'Yesterday';
    if (daysAgo < 7) return new Date(timestamp).toLocaleDateString(undefined, { weekday: 'long' });
    return new Date(timestamp).toLocaleDateString();
};
