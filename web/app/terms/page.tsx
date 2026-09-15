'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';

export default function TermsPage() {
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
          <h1 className="text-3xl font-bold text-foreground mb-2">terms of service</h1>
          <p className="text-muted-foreground text-sm mb-8">last updated: {lastUpdated}</p>

          <div className="space-y-8 text-muted-foreground">
            <section>
              <h2 className="text-xl font-semibold text-foreground mb-4">1. acceptance of terms</h2>
              <p>
                by accessing or using owlette (&quot;the service&quot;), operated by Tridant Inc., a
                Delaware corporation (&quot;Tridant,&quot; &quot;we,&quot; &quot;our,&quot; or
                &quot;us&quot;), you agree to be bound by these terms of service (&quot;terms&quot;).
                if you do not agree to these terms, you may not use the service.
              </p>
              <p className="mt-4">
                we reserve the right to modify these terms at any time. we will notify you of
                significant changes by posting a notice on the service or sending you an email.
                your continued use of the service after such modifications constitutes your
                acceptance of the updated terms.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-foreground mb-4">2. description of service</h2>
              <p>
                owlette is a cloud-connected process management and remote deployment system
                designed for managing Windows applications across multiple machines. the service
                includes:
              </p>
              <ul className="list-disc pl-6 mt-2 space-y-1">
                <li>a web-based dashboard for monitoring and control</li>
                <li>a Windows agent that runs on managed machines</li>
                <li>remote process management capabilities</li>
                <li>software deployment and distribution features</li>
                <li>real-time monitoring and alerting</li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-foreground mb-4">3. account responsibilities</h2>
              <p>
                you are responsible for:
              </p>
              <ul className="list-disc pl-6 mt-2 space-y-1">
                <li>maintaining the confidentiality of your account credentials</li>
                <li>all activities that occur under your account</li>
                <li>ensuring that your use complies with applicable laws</li>
                <li>keeping your contact information up to date</li>
                <li>enabling and maintaining two-factor authentication</li>
              </ul>
              <p className="mt-4">
                you must notify us immediately of any unauthorized use of your account or any
                other breach of security.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-foreground mb-4">4. acceptable use</h2>
              <p>you agree not to use the service to:</p>
              <ul className="list-disc pl-6 mt-2 space-y-1">
                <li>monitor or manage machines without proper authorization</li>
                <li>deploy malicious software or malware</li>
                <li>violate any applicable laws or regulations</li>
                <li>interfere with or disrupt the service or servers</li>
                <li>attempt to gain unauthorized access to any systems</li>
                <li>collect or harvest user data without consent</li>
                <li>use the service for any illegal or fraudulent purpose</li>
                <li>resell or redistribute the service without authorization</li>
              </ul>
              <p className="mt-4">
                we reserve the right to suspend or terminate accounts that violate these terms.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-foreground mb-4">5. intellectual property</h2>
              <p>
                the owlette software is released under the Functional Source License, Version 1.1, Apache 2.0 Future License (FSL-1.1-Apache-2.0).
                you may use, modify, and distribute the software for any permitted purpose — excluding competing commercial uses — in accordance with that license. each release automatically converts to Apache License 2.0 two years after it is made available.
              </p>
              <p className="mt-4">
                the owlette name, logo, and branding are trademarks of Tridant Inc. and may not be used
                without our express written permission.
              </p>
              <p className="mt-4">
                you retain ownership of any data you upload or create using the service. by using
                the service, you grant us a license to store, process, and transmit your data
                solely for the purpose of providing the service.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-foreground mb-4">6. disclaimer of warranties</h2>
              <p className="uppercase font-medium">
                the service is provided &quot;as is&quot; and &quot;as available&quot; without warranties
                of any kind, either express or implied, including but not limited to implied
                warranties of merchantability, fitness for a particular purpose, and non-infringement.
              </p>
              <p className="mt-4">
                we do not warrant that:
              </p>
              <ul className="list-disc pl-6 mt-2 space-y-1">
                <li>the service will be uninterrupted or error-free</li>
                <li>defects will be corrected</li>
                <li>the service is free of viruses or other harmful components</li>
                <li>the results from using the service will meet your requirements</li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-foreground mb-4">7. limitation of liability</h2>
              <p className="uppercase font-medium">
                to the maximum extent permitted by law, Tridant shall not be liable for any indirect,
                incidental, special, consequential, or punitive damages, or any loss of profits
                or revenues, whether incurred directly or indirectly, or any loss of data, use,
                goodwill, or other intangible losses resulting from:
              </p>
              <ul className="list-disc pl-6 mt-4 space-y-1">
                <li>your use or inability to use the service</li>
                <li>any unauthorized access to or use of our servers</li>
                <li>any interruption or cessation of transmission to or from the service</li>
                <li>any bugs, viruses, or similar issues transmitted through the service</li>
                <li>any errors or omissions in any content</li>
              </ul>
              <p className="mt-4">
                in no event shall our total liability exceed the amount you paid us, if any,
                for the use of the service during the twelve (12) months prior to the claim.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-foreground mb-4">8. indemnification</h2>
              <p>
                you agree to indemnify, defend, and hold harmless Tridant and its officers, directors,
                employees, and agents from and against any claims, liabilities, damages, losses,
                and expenses, including reasonable attorneys&apos; fees, arising out of or in any way
                connected with:
              </p>
              <ul className="list-disc pl-6 mt-2 space-y-1">
                <li>your access to or use of the service</li>
                <li>your violation of these terms</li>
                <li>your violation of any third-party rights</li>
                <li>your violation of any applicable laws or regulations</li>
              </ul>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-foreground mb-4">9. termination</h2>
              <p>
                we may suspend or terminate your access to the service at any time, with or
                without cause, and with or without notice. upon termination:
              </p>
              <ul className="list-disc pl-6 mt-2 space-y-1">
                <li>your right to use the service will immediately cease</li>
                <li>you must stop using the owlette agent on all machines</li>
                <li>we may delete your account and associated data</li>
              </ul>
              <p className="mt-4">
                you may terminate your account at any time by contacting us or using the
                account deletion feature in the dashboard.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-foreground mb-4">10. governing law</h2>
              <p>
                these terms shall be governed by and construed in accordance with the laws of
                the State of California, United States, without regard to its conflict of law
                provisions.
              </p>
              <p className="mt-4">
                any legal action or proceeding arising out of or relating to these terms or the
                service shall be brought exclusively in the federal or state courts located in
                California, and you consent to the personal jurisdiction of such courts.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-foreground mb-4">11. dispute resolution</h2>
              <p>
                before filing a claim against Tridant, you agree to try to resolve the dispute
                informally by contacting us at{' '}
                <a href="mailto:support@tridant.io" className="hl-link text-accent-cyan">
                  support@tridant.io
                </a>
                . we will try to resolve the dispute informally by contacting you via email.
                if a dispute is not resolved within 30 days of submission, you or Tridant may
                bring a formal proceeding.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-foreground mb-4">12. severability</h2>
              <p>
                if any provision of these terms is held to be invalid or unenforceable, such
                provision shall be struck and the remaining provisions shall be enforced to
                the fullest extent under law.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-foreground mb-4">13. entire agreement</h2>
              <p>
                these terms, together with our privacy policy, constitute the entire agreement
                between you and Tridant regarding the service and supersede all prior agreements
                and understandings.
              </p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-foreground mb-4">14. contact us</h2>
              <p>
                if you have any questions about these terms, please contact us at:
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
            <Link href="/privacy" className="text-muted-foreground hover:text-muted-foreground">
              privacy policy
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
