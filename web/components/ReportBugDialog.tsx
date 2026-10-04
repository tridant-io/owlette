'use client';

import { useState, useEffect, useRef } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/lib/toast';
import { Loader2 } from 'lucide-react';

const DIALOG_TITLES = [
  'report a bug',
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
  'every bug report makes an owl slightly less confused.',
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

export function ReportBugDialog({ open, onOpenChange }: ReportBugDialogProps) {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('bug');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [dialogTitle, setDialogTitle] = useState(DIALOG_TITLES[0]);
  const [subtitle, setSubtitle] = useState(DIALOG_SUBTITLES[0]);
  const [placeholder, setPlaceholder] = useState(PLACEHOLDERS[0]);
  const [fading, setFading] = useState(false);
  const titleIndex = useRef(0);
  const subtitleIndex = useRef(0);
  const placeholderIndex = useRef(0);

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
    setTitle('');
    setCategory('bug');
    setDescription('');
  };

  const handleSubmit = async () => {
    if (!title.trim()) {
      toast.error('please enter a title');
      return;
    }
    if (!description.trim()) {
      toast.error('please enter a description');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/bug-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          category,
          description: description.trim(),
          browserUA: navigator.userAgent,
          pageUrl: window.location.href,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'failed to submit report');
      }

      toast.success('report submitted — thank you!');
      resetForm();
      onOpenChange(false);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'failed to submit report';
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => {
      if (!isOpen) resetForm();
      onOpenChange(isOpen);
    }}>
      <DialogContent className="border-border sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle
            className="transition-opacity duration-300"
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
            <Label htmlFor="bug-title">title</Label>
            <Input
              id="bug-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="brief description of the issue"
              maxLength={200}
              disabled={submitting}
              className="border-border bg-background"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="bug-category">category</Label>
            <Select value={category} onValueChange={setCategory} disabled={submitting}>
              <SelectTrigger id="bug-category" className="border-border bg-background">
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
        </div>

        <DialogFooter>
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
