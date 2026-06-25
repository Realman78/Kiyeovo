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
