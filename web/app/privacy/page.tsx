'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';

export default function PrivacyPage() {
  const lastUpdated = 'September 14, 2026';
  const router = useRouter();

  return (
    <div className="min-h-screen bg-background py-12 px-4">
      <div className="max-w-3xl mx-auto">
        <div className="mb-8">
          <button
            onClick={() => router.back()}
            className="text-accent-cyan hover:text-accent-cyan-hover text-sm cursor-pointer"
          >
            &larr; back
          </button>
        </div>

        <article className="prose dark:prose-invert prose-slate max-w-none">
          <h1 className="text-3xl font-bold text-foreground mb-2">privacy policy</h1>
          <p className="text-muted-foreground text-sm mb-8">last updated: {lastUpdated}</p>

          <div className="space-y-8 text-muted-foreground">
            <section>
              <h2 className="text-xl font-semibold text-foreground mb-4">1. introduction</h2>
              <p>
                Tridant Inc., a Delaware corporation (&quot;Tridant,&quot; &quot;we,&quot; &quot;our,&quot;
                or &quot;us&quot;), operates owlette, a cloud-connected process management and remote
                deployment system. this privacy policy explains how we collect, use, disclose, and
                safeguard your information when you use our service.
              </p>
              <p className="mt-4">
                owlette is an operations tool: you install an agent on machines you own or administer,
                and we process data from those machines so you can monitor and control them. this
                policy covers both the information you give us about yourself and the information the
                agent reports from your machines.
              </p>
              <p className="mt-4">
                by using owlette, you agree to the collection and use of information in accordance
                with this policy.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-foreground mb-4">2. information we collect</h2>

              <h3 className="text-lg font-medium text-foreground mt-6 mb-3">account and authentication information</h3>
              <p>when you create an account or secure it, we collect:</p>
              <ul className="list-disc pl-6 mt-2 space-y-1">
                <li>email address</li>
                <li>name (first and last)</li>
                <li>password (stored securely using industry-standard hashing, managed by Firebase Authentication)</li>
                <li>two-factor authentication secrets (encrypted at rest) and backup codes (hashed)</li>
                <li>passkey / WebAuthn credentials (public key, credential ID, and device metadata &mdash; we never receive your biometrics or device PIN)</li>
                <li>API keys you create (stored as a hash plus a short non-secret prefix so you can identify them)</li>
                <li>device-trust records when you choose to remember a device for two-factor authentication</li>
              </ul>

              <h3 className="text-lg font-medium text-foreground mt-6 mb-3">machine data</h3>
              <p>when you install the owlette agent on a machine, we collect:</p>
              <ul className="list-disc pl-6 mt-2 space-y-1">
                <li>machine hostname and unique identifiers</li>
                <li>operating system and hardware information (CPU model, GPU, disk, memory)</li>
                <li>system metrics (CPU, memory, disk usage, GPU temperature)</li>
                <li>process information (names, paths, command lines, running status)</li>
                <li>agent heartbeat and online/offline status</li>
                <li>agent and application log output that you or the agent send to us for diagnostics</li>
              </ul>

              <h3 className="text-lg font-medium text-foreground mt-6 mb-3">screenshots</h3>
              <p>
                owlette can capture screenshots of a managed machine&apos;s desktop, either when you
                request one from the dashboard or as part of a diagnostic workflow. these images are
                uploaded to our cloud storage and shown to users who have access to that machine&apos;s
                site.
              </p>
              <p className="mt-4">
                <strong>a screenshot captures whatever is on that desktop at that moment</strong>, which may
                include content unrelated to owlette. you are responsible for ensuring that capturing
                screenshots of your machines is lawful and appropriate in your environment &mdash; including
                notifying anyone who uses those machines. screenshot capture is initiated by you or your
                team, never by us.
              </p>

              <h3 className="text-lg font-medium text-foreground mt-6 mb-3">hoot (AI assistant) data</h3>
              <p>if you use hoot, our AI assistant, we collect and store:</p>
              <ul className="list-disc pl-6 mt-2 space-y-1">
                <li>your chat messages and the assistant&apos;s responses</li>
                <li>the machine and site context attached to a conversation</li>
                <li>records of tool calls the assistant made and their results</li>
                <li>your LLM provider API key, encrypted at rest (see section 8)</li>
              </ul>

              <h3 className="text-lg font-medium text-foreground mt-6 mb-3">deployment content</h3>
              <p>
                when you distribute projects to your machines, we store the files and manifests you
                upload. we treat this content as yours; we do not inspect it except as required to
                operate the service (for example, computing content hashes for deduplication).
              </p>

              <h3 className="text-lg font-medium text-foreground mt-6 mb-3">usage and technical data</h3>
              <p>we automatically collect:</p>
              <ul className="list-disc pl-6 mt-2 space-y-1">
                <li>actions performed (process starts, stops, deployments, configuration changes)</li>
                <li>audit and activity records identifying which user performed a privileged action</li>
                <li>event logs (errors, crashes, status changes)</li>
                <li>IP addresses and request metadata, used for session management, rate limiting, and abuse prevention</li>
                <li>error and performance diagnostics, including stack traces, collected via our monitoring provider</li>
                <li>timestamps of activities</li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-foreground mb-4">3. how we use your information</h2>
              <p>we use the collected information to:</p>
              <ul className="list-disc pl-6 mt-2 space-y-1">
                <li>provide and maintain the owlette service</li>
                <li>monitor machine health and process status</li>
                <li>execute remote commands and deployments</li>
                <li>send alerts and notifications</li>
                <li>authenticate users and secure accounts</li>
                <li>detect, investigate, and prevent abuse, fraud, and security incidents</li>
                <li>maintain audit records of privileged actions</li>
                <li>improve and optimize our service</li>
                <li>respond to support requests</li>
                <li>comply with legal obligations</li>
              </ul>
              <p className="mt-4">
                we do not sell your personal information, and we do not use your data or your
                machines&apos; data to train machine learning models.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-foreground mb-4">4. legal bases for processing (EEA/UK)</h2>
              <p>
                if you are in the European Economic Area or the United Kingdom, we process your
                personal data on the following legal bases under the GDPR / UK GDPR:
              </p>
              <ul className="list-disc pl-6 mt-2 space-y-1">
                <li>
                  <strong>performance of a contract</strong> (Art. 6(1)(b)) &mdash; to provide the service you
                  signed up for: account management, machine monitoring, command execution, and deployments.
                </li>
                <li>
                  <strong>legitimate interests</strong> (Art. 6(1)(f)) &mdash; to keep the service secure and
                  reliable: abuse prevention, rate limiting, audit logging, and error diagnostics. we
                  balance these interests against your rights and limit the data used accordingly.
                </li>
                <li>
                  <strong>consent</strong> (Art. 6(1)(a)) &mdash; for optional features you switch on, such as
                  hoot and screenshot capture. you can withdraw consent at any time by disabling the
                  feature.
                </li>
                <li>
                  <strong>legal obligation</strong> (Art. 6(1)(c)) &mdash; where we must retain or disclose
                  information to comply with applicable law.
                </li>
              </ul>
              <p className="mt-4">
                where you use owlette to manage machines used by other people (for example, your
                employees or contractors), you are the data controller for that personal data and we act
                as your processor. you are responsible for having a lawful basis for that processing and
                for informing those individuals.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-foreground mb-4">5. data storage, location, and security</h2>
              <p>
                owlette is operated from the <strong>United States</strong>. our primary database
                (Google Cloud Firestore) is hosted in the <code>nam5</code> multi-region, which spans
                data centers in the United States. application hosting, object storage, caching, and
                monitoring are likewise operated in or from the United States. content delivery and
                DNS are provided by a global network, which may cache non-personal static assets closer
                to you.
              </p>
              <p className="mt-4">we implement security measures including:</p>
              <ul className="list-disc pl-6 mt-2 space-y-1">
                <li>encryption in transit (TLS/HTTPS, with HSTS enforced)</li>
                <li>encryption at rest (AES-256) for stored data</li>
                <li>application-level encryption for particularly sensitive fields, including two-factor secrets and stored LLM API keys</li>
                <li>encrypted, HTTP-only session cookies and server-side route protection</li>
                <li>optional two-factor authentication and passkey sign-in</li>
                <li>secure authentication tokens with automatic expiration</li>
                <li>machine-specific encryption keys for agent credentials stored on your machines</li>
                <li>role-based access controls and database-level authorization rules</li>
                <li>a content security policy and related browser hardening headers</li>
              </ul>
              <p className="mt-4">
                while we strive to protect your information, no method of transmission over the
                internet is 100% secure. we cannot guarantee absolute security.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-foreground mb-4">6. data retention</h2>
              <p>we retain data as follows:</p>
              <ul className="list-disc pl-6 mt-2 space-y-1">
                <li><strong>account data:</strong> for as long as your account is active. when an account is deleted we immediately revoke its API keys, transfer any owned sites to a successor, clear its pending machine commands, and mark the account deleted so it can no longer sign in or reach your data. the underlying user record is then retained in a deleted state for audit and security purposes rather than erased outright &mdash; if you want the record itself erased, ask us and we will process it as an erasure request (see section 9).</li>
                <li><strong>screenshots:</strong> automatically deleted 30 days after capture. the agent additionally keeps only the most recent 20 captures per machine in its history.</li>
                <li><strong>queued machine commands:</strong> pending commands expire after 1 hour; completed command records are removed after 24 hours.</li>
                <li><strong>machine metrics:</strong> automatically deleted 400 days after collection.</li>
                <li><strong>event logs:</strong> automatically deleted 400 days after the logged event.</li>
                <li><strong>process and configuration data:</strong> until the machine is removed from your account.</li>
                <li><strong>hoot conversations:</strong> until you delete them. deleting a conversation removes it from every listing and hides it from the interface; the underlying record is retained in a deleted state. ask us if you need it erased.</li>
                <li><strong>deployment content:</strong> until you delete the associated release or roost.</li>
                <li><strong>audit and security logs:</strong> retained for as long as needed to investigate incidents and meet legal obligations.</li>
              </ul>
              <p className="mt-4">
                you may request deletion of your data at any time &mdash; see section 9.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-foreground mb-4">7. third-party services and subprocessors</h2>
              <p>
                we use the following providers to operate owlette. each processes data only as needed to
                provide its function, and each is bound by its own data processing terms.
              </p>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="border-b border-border text-left text-foreground">
                      <th className="py-2 pr-4 font-medium">provider</th>
                      <th className="py-2 pr-4 font-medium">purpose</th>
                      <th className="py-2 font-medium">region</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b border-border/50">
                      <td className="py-2 pr-4">Google Firebase / Google Cloud</td>
                      <td className="py-2 pr-4">authentication, database, screenshot and file storage</td>
                      <td className="py-2">USA</td>
                    </tr>
                    <tr className="border-b border-border/50">
                      <td className="py-2 pr-4">Railway</td>
                      <td className="py-2 pr-4">primary application hosting</td>
                      <td className="py-2">USA</td>
                    </tr>
                    <tr className="border-b border-border/50">
                      <td className="py-2 pr-4">Vercel</td>
                      <td className="py-2 pr-4">failover application hosting</td>
                      <td className="py-2">USA</td>
                    </tr>
                    <tr className="border-b border-border/50">
                      <td className="py-2 pr-4">Cloudflare</td>
                      <td className="py-2 pr-4">DNS, load balancing, CDN, and object storage for deployment content</td>
                      <td className="py-2">global / USA</td>
                    </tr>
                    <tr className="border-b border-border/50">
                      <td className="py-2 pr-4">Upstash</td>
                      <td className="py-2 pr-4">rate limiting and caching</td>
                      <td className="py-2">USA</td>
                    </tr>
                    <tr className="border-b border-border/50">
                      <td className="py-2 pr-4">Sentry</td>
                      <td className="py-2 pr-4">error and performance monitoring</td>
                      <td className="py-2">USA</td>
                    </tr>
                    <tr className="border-b border-border/50">
                      <td className="py-2 pr-4">Resend</td>
                      <td className="py-2 pr-4">transactional email (alerts, account and security notices)</td>
                      <td className="py-2">USA</td>
                    </tr>
                    <tr className="border-b border-border/50">
                      <td className="py-2 pr-4">Instatus</td>
                      <td className="py-2 pr-4">public service status page</td>
                      <td className="py-2">USA / EU</td>
                    </tr>
                    <tr>
                      <td className="py-2 pr-4">Anthropic, OpenAI</td>
                      <td className="py-2 pr-4">hoot AI assistant &mdash; only if you enable it (see section 8)</td>
                      <td className="py-2">USA</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="mt-4">
                we may update this list as our infrastructure changes. material changes will be
                reflected here along with an updated &quot;last updated&quot; date.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-foreground mb-4">8. AI features and your LLM provider</h2>
              <p>
                hoot is optional and off unless enabled for your site. hoot uses{' '}
                <strong>your own API key</strong> for an AI provider (currently Anthropic or OpenAI) &mdash;
                we do not provide a shared key and we do not send your data to any AI provider unless
                you have supplied a key and enabled the feature.
              </p>
              <p className="mt-4">when hoot is enabled and you send a message:</p>
              <ul className="list-disc pl-6 mt-2 space-y-1">
                <li>your key is stored encrypted at rest and decrypted server-side only to make the request</li>
                <li>your message, the conversation history, and relevant machine context (such as system metrics, process lists, and command output) are transmitted from our servers to your chosen AI provider</li>
                <li>the provider processes that data under <strong>your</strong> account and its own terms &mdash; your agreement with that provider governs how they retain and use it</li>
                <li>you may optionally provision your key down to a machine so hoot can run locally on that machine; in that case the key is re-encrypted with a machine-bound key on your hardware</li>
              </ul>
              <p className="mt-4">
                you can remove your stored key or disable hoot at any time from settings. doing so
                stops all further transmission to the AI provider; data already sent is subject to that
                provider&apos;s retention policy, not ours.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-foreground mb-4">9. your rights</h2>

              <h3 className="text-lg font-medium text-foreground mt-6 mb-3">all users</h3>
              <p>regardless of where you live, you can:</p>
              <ul className="list-disc pl-6 mt-2 space-y-1">
                <li>access your account data through the dashboard</li>
                <li>update or correct your information</li>
                <li>delete your account and associated data</li>
                <li>export your data &mdash; contact us and we will provide it in a portable format</li>
              </ul>

              <h3 className="text-lg font-medium text-foreground mt-6 mb-3">EEA and UK residents (GDPR / UK GDPR)</h3>
              <p>you have the right to:</p>
              <ul className="list-disc pl-6 mt-2 space-y-1">
                <li>access the personal data we hold about you</li>
                <li>rectify inaccurate or incomplete data</li>
                <li>erasure of your data (&quot;right to be forgotten&quot;)</li>
                <li>restrict or object to processing, including processing based on legitimate interests</li>
                <li>data portability &mdash; receive your data in a structured, machine-readable format</li>
                <li>withdraw consent at any time, without affecting processing carried out before withdrawal</li>
                <li>lodge a complaint with your local supervisory authority (in the UK, the Information Commissioner&apos;s Office)</li>
              </ul>
              <p className="mt-4">
                we are not subject to automated decision-making or profiling that produces legal effects
                concerning you.
              </p>

              <h3 className="text-lg font-medium text-foreground mt-6 mb-3">California residents (CCPA/CPRA)</h3>
              <p>you have the right to:</p>
              <ul className="list-disc pl-6 mt-2 space-y-1">
                <li>know what personal information is collected, used, and disclosed</li>
                <li>request deletion of your personal information</li>
                <li>correct inaccurate personal information</li>
                <li>opt out of the sale or sharing of personal information (we do not sell or share your data)</li>
                <li>limit the use of sensitive personal information</li>
                <li>non-discrimination for exercising your privacy rights</li>
              </ul>

              <h3 className="text-lg font-medium text-foreground mt-6 mb-3">how to exercise your rights</h3>
              <p>
                email{' '}
                <a href="mailto:support@tridant.io" className="hl-link text-accent-cyan">
                  support@tridant.io
                </a>{' '}
                from the address on your account, or contact us as described in section 15. we respond
                to requests within <strong>30 days</strong>. we may need to verify your identity before
                acting, and we will tell you if we need an extension permitted by law.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-foreground mb-4">10. international data transfers</h2>
              <p>
                owlette is operated from the United States. if you access the service from the EEA, the
                UK, or elsewhere outside the United States, your personal data will be transferred to
                and processed in the United States, which may not provide the same level of data
                protection as your home jurisdiction.
              </p>
              <p className="mt-4">
                where we transfer personal data out of the EEA or UK, we rely on the European
                Commission&apos;s Standard Contractual Clauses (and the UK International Data Transfer
                Addendum where applicable), together with supplementary technical measures such as
                encryption in transit and at rest. our providers listed in section 7 are engaged under
                equivalent terms. you can request further information about these safeguards using the
                contact details in section 15.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-foreground mb-4">11. cookies and tracking</h2>
              <p>
                owlette uses cookies and similar technologies for authentication and session
                management. these are essential for the service to function and cannot be
                disabled while using owlette.
              </p>
              <p className="mt-4">
                we use Firebase Authentication together with an encrypted session cookie to maintain
                your login. if you choose to remember a device for two-factor authentication, we set an
                additional cookie for that purpose. we do not use tracking cookies for advertising and
                we do not run third-party advertising or analytics trackers.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-foreground mb-4">12. security incident notification</h2>
              <p>
                if we become aware of a personal data breach affecting your information, we will notify
                you without undue delay and, where required, within the timeframes set by applicable law
                &mdash; including notifying the relevant supervisory authority within 72 hours where the
                GDPR requires it. our notice will describe what happened, the data involved, and the
                steps we are taking.
              </p>
              <p className="mt-4">
                to report a suspected vulnerability or security issue, email{' '}
                <a href="mailto:support@tridant.io" className="hl-link text-accent-cyan">
                  support@tridant.io
                </a>{' '}
                with &quot;security&quot; in the subject line.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-foreground mb-4">13. children&apos;s privacy</h2>
              <p>
                owlette is not intended for use by anyone under the age of 16. we do not knowingly
                collect personal information from children. if you are a parent or guardian
                and believe your child has provided us with personal information, please contact us and
                we will delete it.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-foreground mb-4">14. changes to this policy</h2>
              <p>
                we may update this privacy policy from time to time. we will notify you of any
                changes by posting the new privacy policy on this page and updating the
                &quot;last updated&quot; date. for material changes, we will also notify account holders
                by email.
              </p>
              <p className="mt-4">
                we encourage you to review this privacy policy periodically for any changes.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-foreground mb-4">15. contact us</h2>
              <p>
                if you have any questions about this privacy policy or our data practices,
                please contact us at:
              </p>
              <p className="mt-4">
                <strong>email:</strong>{' '}
                <a href="mailto:support@tridant.io" className="hl-link text-accent-cyan">
                  support@tridant.io
                </a>
              </p>
              <p className="mt-2">
                <strong>company:</strong> Tridant Inc., a Delaware corporation
              </p>
              <p className="mt-2">
                <strong>principal place of business:</strong> California, USA
              </p>
            </section>
          </div>
        </article>

        <div className="mt-12 pt-8 border-t border-border text-center">
          <p className="text-muted-foreground text-sm">
            <Link href="/terms" className="text-muted-foreground hover:text-muted-foreground">
              terms of service
            </Link>
            {' '}&middot;{' '}
            <Link href="/dashboard" className="text-muted-foreground hover:text-muted-foreground">
              dashboard
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
