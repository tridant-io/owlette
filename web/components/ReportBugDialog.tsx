'use client';

import { useState, useEffect, useRef, useCallback, type ClipboardEvent } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { IssueAttachments } from '@/components/IssueAttachments';
import { toast } from '@/lib/toast';
import {
  admitIssueFiles,
  uploadIssueFiles,
  type IssueAttachment,
  type IssueFileSource,
} from '@/lib/issueUploads';
import { Loader2 } from 'lucide-react';

const DIALOG_TITLES = [
  'submit issue',
  'share feedback',
  'tell us how terrible we\'re doing',
  'yell into the void',
  'file a complaint with management',
  'constructive criticism welcome',
  'it\'s not you, it\'s us',
  'we can take it',
];

const DIALOG_SUBTITLES = [
  'help us improve owlette by reporting issues or requesting features.',
  'we promise not to cry. probably.',
  'every issue makes an owl slightly less confused.',
  'our therapist says we need to hear this.',
  'be honest. we\'re wearing our thick skin today.',
  'turning your frustration into features since 2024.',
];

const PLACEHOLDERS = [
  'what happened? what did you expect?',
  'describe the chaos...',
  'paint us a picture of the disaster.',
  'what broke this time?',
  'tell us everything. spare no feelings.',
  'in your own words, how badly did we mess up?',
];

interface ReportBugDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function revokePreviews(attachments: IssueAttachment[]) {
  for (const attachment of attachments) {
    if (attachment.preview) URL.revokeObjectURL(attachment.preview);
  }
}

export function ReportBugDialog({ open, onOpenChange }: ReportBugDialogProps) {
  const [category, setCategory] = useState('bug');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [attachments, setAttachments] = useState<IssueAttachment[]>([]);
  const [notices, setNotices] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [dialogTitle, setDialogTitle] = useState(DIALOG_TITLES[0]);
  const [subtitle, setSubtitle] = useState(DIALOG_SUBTITLES[0]);
  const [placeholder, setPlaceholder] = useState(PLACEHOLDERS[0]);
  const [fading, setFading] = useState(false);
  const titleIndex = useRef(0);
  const subtitleIndex = useRef(0);
  const placeholderIndex = useRef(0);
  // the files held now, read outside render by add and the unmount cleanup
  const attachmentsRef = useRef<IssueAttachment[]>([]);
  const nextId = useRef(0);

  const keepAttachments = useCallback((next: IssueAttachment[]) => {
    attachmentsRef.current = next;
    setAttachments(next);
  }, []);

  useEffect(() => () => revokePreviews(attachmentsRef.current), []);

  // Cycle dialog title text while open
  useEffect(() => {
    if (!open) return;

    // Randomize starting points each time the dialog opens
    titleIndex.current = Math.floor(Math.random() * DIALOG_TITLES.length);
    subtitleIndex.current = Math.floor(Math.random() * DIALOG_SUBTITLES.length);
    placeholderIndex.current = Math.floor(Math.random() * PLACEHOLDERS.length);
    setDialogTitle(DIALOG_TITLES[titleIndex.current]);
    setSubtitle(DIALOG_SUBTITLES[subtitleIndex.current]);
    setPlaceholder(PLACEHOLDERS[placeholderIndex.current]);

    const interval = setInterval(() => {
      setFading(true);
      setTimeout(() => {
        titleIndex.current = (titleIndex.current + 1) % DIALOG_TITLES.length;
        subtitleIndex.current = (subtitleIndex.current + 1) % DIALOG_SUBTITLES.length;
        placeholderIndex.current = (placeholderIndex.current + 1) % PLACEHOLDERS.length;
        setDialogTitle(DIALOG_TITLES[titleIndex.current]);
        setSubtitle(DIALOG_SUBTITLES[subtitleIndex.current]);
        setPlaceholder(PLACEHOLDERS[placeholderIndex.current]);
        setFading(false);
      }, 300);
    }, 4000);

    return () => clearInterval(interval);
  }, [open]);

  const resetForm = () => {
    setCategory('bug');
    setDescription('');
    revokePreviews(attachmentsRef.current);
    keepAttachments([]);
    setNotices([]);
    setError(null);
    setStatus('');
  };

  const addFiles = (sources: IssueFileSource[]) => {
    const held = attachmentsRef.current;
    const { admitted, refused } = admitIssueFiles(
      held.map((attachment) => attachment.file),
      sources,
    );
    const added = admitted.map((file) => ({
      id: nextId.current++,
      file,
      preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
    }));
    keepAttachments([...held, ...added]);
    setNotices(refused);
  };

  const removeFile = (id: number) => {
    revokePreviews(attachmentsRef.current.filter((attachment) => attachment.id === id));
    keepAttachments(attachmentsRef.current.filter((attachment) => attachment.id !== id));
  };

  const pasteScreenshots = (event: ClipboardEvent) => {
    const items = Array.from(event.clipboardData?.items ?? []);
    // a copy from a web page or an office app carries an image beside its text; the text box wants it
    if (items.some((item) => item.type === 'text/plain')) return;
    const files = items
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) return;
    event.preventDefault();
    if (submitting) return;
    addFiles(files.map((file) => ({ file, label: 'pasted image' })));
  };

  const handleSubmit = async () => {
    if (!description.trim()) {
      toast.error('please enter a description');
      return;
    }

    setSubmitting(true);
    setError(null);
    let files: string[] | undefined;
    if (attachments.length > 0) {
      setStatus('uploading attachments (0%)');
      try {
        files = await uploadIssueFiles(
          attachments.map((attachment) => attachment.file),
          (percent) => setStatus(`uploading attachments (${percent}%)`),
        );
      } catch (cause: unknown) {
        // nothing was filed: the files stay for a retry
        setError(cause instanceof Error ? cause.message : String(cause));
        setStatus('');
        setSubmitting(false);
        return;
      }
      setStatus('submitting');
    }

    try {
      const res = await fetch('/api/bug-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category,
          description: description.trim(),
          browserUA: navigator.userAgent,
          pageUrl: window.location.href,
          ...(files ? { files } : {}),
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'failed to submit issue');
      }

      const data = await res.json().catch(() => ({}));
      const number = Number.isInteger(data.number) ? data.number : null;
      toast.success(number !== null ? `issue #${number} submitted — thank you!` : 'issue submitted — thank you!');
      resetForm();
      onOpenChange(false);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'failed to submit issue';
      toast.error(message);
    } finally {
      setSubmitting(false);
      setStatus('');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => {
      // an upload in flight would file the issue after the dialog had gone
      if (!isOpen && submitting) return;
      if (!isOpen) resetForm();
      onOpenChange(isOpen);
    }}>
      <DialogContent
        className="border-border sm:max-w-[480px] max-h-[calc(100dvh-2rem)] overflow-y-auto"
        onPaste={pasteScreenshots}
      >
        <DialogHeader>
          <DialogTitle
            // pr-6 keeps the longest rotating title clear of the close button on a phone
            className="pr-6 transition-opacity duration-300"
            style={{ opacity: fading ? 0 : 1 }}
          >
            {dialogTitle}
          </DialogTitle>
          <DialogDescription
            className="transition-opacity duration-300"
            style={{ opacity: fading ? 0 : 1 }}
          >
            {subtitle}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="bug-category">category</Label>
            <Select value={category} onValueChange={setCategory} disabled={submitting}>
              <SelectTrigger id="bug-category" className="w-full border-border bg-background">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="bug">something broke</SelectItem>
                <SelectItem value="feature_request">wouldn&apos;t it be nice if...</SelectItem>
                <SelectItem value="other">it&apos;s complicated</SelectItem>
                <SelectItem value="compliment">actually, you&apos;re doing great</SelectItem>
                <SelectItem value="rant">i just need to vent</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="bug-description">description</Label>
            <Textarea
              id="bug-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={placeholder}
              maxLength={5000}
              rows={5}
              disabled={submitting}
              className="border-border bg-background"
            />
          </div>

          <IssueAttachments
            attachments={attachments}
            busy={submitting}
            notices={notices}
            onAdd={(picked) => addFiles(picked.map((file) => ({ file, label: file.name })))}
            onRemove={removeFile}
          />

          {error && (
            <InlineNotice data-testid="report-error">
              <p className="text-sm">{error}</p>
            </InlineNotice>
          )}
        </div>

        <DialogFooter className="sm:items-center">
          {status && (
            // the footer stacks in reverse on a phone: order-last keeps the status above the buttons
            <p className="order-last text-xs text-muted-foreground sm:order-none sm:mr-auto" aria-live="polite" data-testid="report-status">
              {status}
            </p>
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting} className="bg-secondary border border-border cursor-pointer">
            cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {submitting ? 'submitting...' : 'submit'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
