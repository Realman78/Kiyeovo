type ClassValue = string | number | boolean | undefined | null | { [key: string]: boolean };

export function cn(...inputs: ClassValue[]) {
  return inputs
    .filter(Boolean)
    .map(input => {
      if (typeof input === 'string') return input;
      if (input && typeof input === 'object') {
        return Object.entries(input)
          .filter(([_, value]) => value)
          .map(([key]) => key)
          .join(' ');
      }
      return '';
    })
    .join(' ')
    .trim();
}
