export async function handleDeleteAccount() {
    try {
        const result = await window.kiyeovoAPI.deleteAccountAndData();
        if (!result.success) {
            console.error('Failed to delete account:', result.error);
            return;
        }
    } catch (error) {
        console.error('Failed to delete account:', error);
    }
};