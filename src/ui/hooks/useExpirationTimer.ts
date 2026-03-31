import { useEffect, useState } from "react";

export const useExpirationTimer = (expiresAt?: number) => {
  const [timeLeft, setTimeLeft] = useState(0);

  useEffect(() => {
    if (!expiresAt) return;

    const updateTimer = () => {
      setTimeLeft(Math.max(0, expiresAt - Date.now()));
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  const minutes = Math.floor(timeLeft / 60000);
  const seconds = Math.floor((timeLeft % 60000) / 1000);

  return { minutes, seconds, timeLeft };
};
