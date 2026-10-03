'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/lib/toast';
import { CheckCircle2, XCircle, Send, Loader2, ChevronDown } from 'lucide-react';

interface EmailConfig {
  provider: string;
  fromEmail: string;
  adminEmail: string | null;
  environment: string;
  apiKeyConfigured: boolean;
  adminEmailConfigured: boolean;
}

type TestEmailResult =
  | {
      success: true;
      template?: string;
      to?: string;
      emailId?: string;
      [extra: string]: unknown;
    }
  | {
      success: false;
      error?: string;
      details?: string | Record<string, unknown>;
    };

const EMAIL_TEMPLATES = [
  { id: 'test', label: 'test email', description: 'generic config verification' },
  { id: 'process_crash', label: 'process crashed', description: 'monitored process stopped unexpectedly' },
  { id: 'process_start_failed', label: 'process failed to start', description: 'monitored process could not be launched' },
  { id: 'agent_alert', label: 'agent connection failure', description: 'agent lost connection to cloud' },
  { id: 'threshold_alert', label: 'threshold alert', description: 'metric breached a configured threshold' },
  { id: 'machines_offline', label: 'machines offline', description: 'stale heartbeat detected by health check' },
  { id: 'cortex_escalation', label: 'hoot escalation', description: 'autonomous investigation could not resolve issue' },
  { id: 'api_key_expiring', label: 'api key expiring', description: 'daily notice ladder before an api key expires' },
  { id: 'welcome', label: 'welcome email', description: 'sent to new users on signup' },
  { id: 'user_signup', label: 'admin signup notification', description: 'admin notified of new user registration' },
] as const;

export default function EmailPage() {
  const [config, setConfig] = useState<EmailConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [lastResult, setLastResult] = useState<TestEmailResult | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState('test');

  useEffect(() => {
    fetchConfig();
  }, []);

  const fetchConfig = async () => {
    try {
      const response = await fetch('/api/platform/email/config');
      if (response.ok) {
        setConfig(await response.json());
      }
    } catch {
      // Config fetch failed — page still usable
    } finally {
      setConfigLoading(false);
    }
  };

  const sendTestEmail = async () => {
    setIsSending(true);
    setLastResult(null);

    try {
      const response = await fetch('/api/test-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template: selectedTemplate }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        const templateLabel = EMAIL_TEMPLATES.find(t => t.id === selectedTemplate)?.label || selectedTemplate;
        toast.success('Test email sent successfully!', {
          description: `"${templateLabel}" sent to ${data.to}`,
        });
        setLastResult({ success: true, ...data });
      } else {
        toast.error('Failed to send test email', {
          description: data.error || 'Unknown error',
        });
        setLastResult({ success: false, error: data.error, details: data.details });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      toast.error('Failed to send test email', { description: errorMessage });
      setLastResult({ success: false, error: 'Request failed', details: errorMessage });
    } finally {
      setIsSending(false);
    }
  };

  const currentTemplate = EMAIL_TEMPLATES.find(t => t.id === selectedTemplate);

  return (
    <div className="p-8">
      <div className="max-w-screen-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground mb-2">email</h1>
        <p className="text-muted-foreground">
          Email notification configuration and testing
        </p>
      </div>

      {/* Configuration */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle>configuration</CardTitle>
          <CardDescription>
            current email provider settings and status
          </CardDescription>
        </CardHeader>
        <CardContent>
          {configLoading ? (
            <div className="space-y-3">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="h-5 bg-muted rounded animate-pulse w-64" />
              ))}
            </div>
          ) : config ? (
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4 text-sm">
              <div>
                <dt className="text-muted-foreground font-medium">provider</dt>
                <dd className="mt-1 flex items-center gap-2">
                  {config.provider}
                  <Badge
                    variant={config.apiKeyConfigured ? 'default' : 'destructive'}
                    className={config.apiKeyConfigured ? 'bg-success-solid text-success-solid-foreground' : ''}
                  >
                    {config.apiKeyConfigured ? 'connected' : 'not configured'}
                  </Badge>
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground font-medium">environment</dt>
                <dd className="mt-1">{config.environment}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground font-medium">from address</dt>
                <dd className="mt-1 font-mono text-xs">{config.fromEmail}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground font-medium">admin email</dt>
                <dd className="mt-1 flex items-center gap-2">
                  {config.adminEmailConfigured ? (
                    <span className="font-mono text-xs">{config.adminEmail}</span>
                  ) : (
                    <span className="text-destructive">not configured</span>
                  )}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-destructive">Failed to load email configuration</p>
          )}
        </CardContent>
      </Card>

      {/* Test Email */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle>test email</CardTitle>
          <CardDescription>
            send a test email to preview any notification template with sample data
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Template selector */}
          <div className="space-y-2">
            <label htmlFor="template-select" className="text-sm font-medium text-muted-foreground">
              template
            </label>
            <div className="relative w-full max-w-md">
              <select
                id="template-select"
                value={selectedTemplate}
                onChange={(e) => setSelectedTemplate(e.target.value)}
                className="w-full appearance-none rounded-md border border-border bg-background px-3 py-2 pr-10 text-base md:text-sm text-foreground focus:border-accent-cyan cursor-pointer"
              >
                {EMAIL_TEMPLATES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            </div>
            {currentTemplate && (
              <p className="text-xs text-muted-foreground">{currentTemplate.description}</p>
            )}
          </div>

          <Button
            onClick={sendTestEmail}
            disabled={isSending}
            className="cursor-pointer"
          >
            {isSending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Sending...
              </>
            ) : (
              <>
                <Send className="h-4 w-4" />
                send test email
              </>
            )}
          </Button>

          {lastResult && (
            <div className={`p-4 rounded-lg border ${
              lastResult.success
                ? 'bg-success-surface border-success-border'
                : 'bg-danger-surface border-danger-border'
            }`}>
              <div className="flex items-center gap-2 mb-2">
                {lastResult.success ? (
                  <CheckCircle2 className="h-4 w-4 text-success" />
                ) : (
                  <XCircle className="h-4 w-4 text-danger" />
                )}
                <span className={`font-semibold text-sm ${
                  lastResult.success ? 'text-success' : 'text-danger'
                }`}>
                  {lastResult.success ? 'Email sent successfully' : 'Failed to send email'}
                </span>
              </div>
              <div className="space-y-1 text-sm text-muted-foreground">
                {lastResult.success ? (
                  <>
                    <p>Template: <span className="text-foreground font-medium">{EMAIL_TEMPLATES.find(t => t.id === lastResult.template)?.label || lastResult.template}</span></p>
                    <p>Sent to <span className="text-foreground font-medium">{lastResult.to}</span></p>
                    <p>email ID: <span className="font-mono text-xs">{lastResult.emailId}</span></p>
                  </>
                ) : (
                  <>
                    <p>{lastResult.error}</p>
                    {lastResult.details && (
                      <pre className="mt-1 p-2 bg-danger-surface border border-danger-border rounded text-xs overflow-x-auto">
                        {typeof lastResult.details === 'string'
                          ? lastResult.details
                          : JSON.stringify(lastResult.details, null, 2)}
                      </pre>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
      </div>
    </div>
  );
}
