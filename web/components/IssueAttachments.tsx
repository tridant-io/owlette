'use client';

import { useRef } from 'react';
import { Film, Paperclip, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Label } from '@/components/ui/label';
import { ISSUE_ATTACHMENT_MAX_BYTES } from '@/lib/issues';
import { attachmentBytes, ISSUE_FILE_ACCEPT, isVideoFile, type IssueAttachment } from '@/lib/issueUploads';

const MB = 1024 * 1024;

function megabytes(bytes: number): string {
  // a small screenshot still shows as something
  return Math.max(bytes / MB, 0.1).toFixed(1);
}

interface IssueAttachmentsProps {
  attachments: IssueAttachment[];
  /** Sending: no adding or removing until it settles. */
  busy: boolean;
  notices: string[];
  onAdd: (files: File[]) => void;
  onRemove: (id: number) => void;
}

/** The submit issue dialog's screenshots and videos; the dialog owns the files. */
export function IssueAttachments({ attachments, busy, notices, onAdd, onRemove }: IssueAttachmentsProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const used = attachmentBytes(attachments.map((attachment) => attachment.file));
  const screenshots = attachments.filter((attachment) => !isVideoFile(attachment.file));
  const limit = ISSUE_ATTACHMENT_MAX_BYTES / MB;

  return (
    <div className="flex flex-col gap-2" data-testid="report-attachments">
      <Label>attachments</Label>

      {attachments.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {attachments.map((attachment) => {
            const video = isVideoFile(attachment.file);
            return (
              <li
                key={attachment.id}
                className="relative"
                data-testid={video ? 'report-video' : 'report-screenshot'}
              >
                {video ? (
                  <div
                    title={attachment.file.name}
                    className="flex size-16 flex-col items-center justify-center gap-1 rounded-md border border-border bg-muted text-muted-foreground"
                  >
                    <Film aria-hidden className="size-5" />
                    <span className="text-[10px] leading-none">{megabytes(attachment.file.size)} MB</span>
                  </div>
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element -- a local object url, nothing to optimise
                  <img
                    src={attachment.preview ?? undefined}
                    alt={`screenshot ${screenshots.indexOf(attachment) + 1}`}
                    className="size-16 rounded-md border border-border object-cover"
                  />
                )}
                <button
                  type="button"
                  aria-label={video ? `remove ${attachment.file.name}` : 'remove screenshot'}
                  disabled={busy}
                  onClick={() => onRemove(attachment.id)}
                  className="absolute -top-1.5 -right-1.5 flex size-5 cursor-pointer items-center justify-center rounded-full border border-border bg-secondary text-secondary-foreground disabled:pointer-events-none disabled:opacity-50"
                >
                  <X className="size-3" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button variant="outline" size="sm" onClick={() => inputRef.current?.click()} disabled={busy}>
          <Paperclip aria-hidden />
          add screenshots or video
        </Button>
        <span className="text-xs text-muted-foreground" data-testid="report-attachment-limit">
          {used > 0 ? `${megabytes(used)} of ${limit} MB used` : `up to ${limit} MB, or paste an image`}
        </span>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ISSUE_FILE_ACCEPT}
          className="hidden"
          tabIndex={-1}
          aria-hidden
          data-testid="report-attachment-input"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            // cleared, so picking the same file again still fires
            event.target.value = '';
            if (files.length > 0) onAdd(files);
          }}
        />
      </div>

      {notices.length > 0 && (
        <InlineNotice data-testid="report-attachment-notice">
          {notices.map((notice, index) => (
            <p key={index} className="text-sm">
              {notice}
            </p>
          ))}
        </InlineNotice>
      )}
    </div>
  );
}
