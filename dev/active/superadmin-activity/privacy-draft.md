# privacy policy: proposed wording for the activity feature

For the owner to approve. Nothing here is applied: `web/app/privacy/page.tsx` is untouched.

## What the feature does that the policy does not yet say

1. Every sign-in is recorded (who, when, with a password, Google or a passkey), and so is every
   second factor passed or failed. Each record keeps the network the request came from (the
   internet provider, as its autonomous system number) and a shortened IP address (the /24 range
   for IPv4, the /64 range for IPv6). It is stored in the platform's audit records, not in a site's
   audit log, so a site's admins cannot read it.
2. Owlette staff (superadmins) can read activity across every site on the activity page: changes,
   refusals and sign-ins, to investigate abuse and security incidents. A check also flags risky
   activity (a new superadmin, removed 2fa, a deleted site, bursts of failures, a sign-in from a
   new network) and emails owlette staff.
3. Failed passwords are not recorded: Firebase handles them.

## Lines it would change in `web/app/privacy/page.tsx`

### line 111, the data collected list: add after it

Current line 111:

```
<li>the network (internet provider) you pass two-factor authentication from, recorded by its autonomous system number rather than your IP address</li>
```

Add:

```
<li>each time you sign in, and each second-factor check you pass or fail, the time, the method, the network (internet provider) the request came from, recorded by its autonomous system number, and a shortened IP address (the first three parts of an IPv4 address, or the first half of an IPv6 one). these records are kept in owlette's platform audit records, not in your site's audit log</li>
```

### line 127, the purposes list: replace

Current:

```
<li>detect, investigate, and prevent abuse, fraud, and security incidents</li>
```

With:

```
<li>detect, investigate, and prevent abuse, fraud, and security incidents, including by letting owlette staff view activity (changes, refusals and sign-ins) across all sites and by flagging unusual activity automatically</li>
```

### line 217, the retention list: replace

Current:

```
<li><strong>audit and security logs:</strong> retained for as long as needed to investigate incidents and meet legal obligations.</li>
```

With (only if the owner wants the sign-in records named; they follow the same rule):

```
<li><strong>audit and security logs:</strong> including sign-in records and the findings flagged from them, retained for as long as needed to investigate incidents and meet legal obligations.</li>
```

## Owner decisions

- Whether line 217 is changed or the existing sentence already covers sign-in records. As built,
  nothing deletes these records automatically.
- The shortened address is, as for swoop step-ups (line 112), the /24 or /64 range. The line 112
  wording ("the first three parts of an IPv4 address, or the first half of an IPv6 one") is reused so
  the two lines read the same.
