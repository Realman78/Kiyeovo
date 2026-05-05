import { app } from "electron";

export function isDev(): boolean {
    return !app.isPackaged && process.env.NODE_ENV === 'development';
}