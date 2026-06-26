import React, { useState } from 'react';
import { FolderOpen, HardDrive } from 'lucide-react';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { useToast } from '../../ui/use-toast';

interface UploadsQuotaDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  savedFilePath: string | null;
}

export const UploadsQuotaDialog: React.FC<UploadsQuotaDialogProps> = ({
  open,
  onOpenChange,
  savedFilePath,
}) => {
  const { toast } = useToast();
  const [openingFolder, setOpeningFolder] = useState(false);

  const uploadsFolderPath = savedFilePath
    ? savedFilePath.replace(/[\\/][^\\/]*$/, '')
    : 'the uploads folder';

  const handleShowInFolder = async () => {
    if (!savedFilePath || openingFolder) return;

    setOpeningFolder(true);
    try {
      const result = await window.kiyeovoAPI.openFileLocation(savedFilePath);
      if (!result.success) {
        toast.error(result.error || 'Failed to show uploads folder');
      }
    } catch (error) {
      console.error('Failed to show uploads folder:', error);
      toast.error('Failed to show uploads folder');
    } finally {
      setOpeningFolder(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HardDrive className="h-5 w-5 text-amber-400" />
            Your saved uploads use over 100 MB!
          </DialogTitle>
          <DialogDescription>
            Pasted images and generated text files are kept at <span className='font-bold'>{uploadsFolderPath}</span> <br />That keeps sent uploads available to the app.
            You can remove files you no longer need from the uploads folder so that it doesn't take up as much space.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <p className="text-sm text-muted-foreground">
            This warning appears only once per app session and does not interrupt the send.
          </p>
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Dismiss
          </Button>
          <Button
            type="button"
            onClick={() => void handleShowInFolder()}
            disabled={!savedFilePath || openingFolder}
          >
            <FolderOpen className="h-4 w-4" />
            Show in folder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
