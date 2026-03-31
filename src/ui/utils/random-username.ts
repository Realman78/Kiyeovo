import { uniqueNamesGenerator, adjectives, colors, animals } from 'unique-names-generator';

export const generateRandomUsername = (): string => {
    return uniqueNamesGenerator({ dictionaries: [adjectives, colors, animals], separator: '_' });
};