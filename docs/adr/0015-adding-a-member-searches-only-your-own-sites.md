# Adding a member searches only your own sites

The add-member dialog suggests people as a site's owner or admin types, from `GET /api/sites/{siteId}/member-candidates`. It offers only the people with an active member row on the sites where the caller already holds SITE_MEMBER_MANAGE, minus those already on the site; anyone else is added by their exact email, which `POST /api/sites/{siteId}/members` resolves. Superadmins search every account. Neither ever offers a soft-deleted account or a superadmin's, since superadmins reach every site without a member row. Site creation is self-serve, so any account can create a site, own it and so be a site admin, and a platform-wide search for site admins would list every account on owlette to anyone who signs up. The union of the rosters a caller administers is what they can already read, one site at a time, through `GET /api/sites/{siteId}/members`, so the suggestions disclose nothing new.

## Consequences

- A customer with a single site gets no suggestions: there is no other roster to draw on, so they add people by full email.
- The list is fetched once per dialog open and filtered in the browser, with no search parameter. Firestore has no case-insensitive text match, and every request costs an audit row and a tick of the 30/min SITE_MEMBER_MANAGE budget that adding, removing and changing members share.
- API keys are refused (`403 api_key_not_permitted`): a key scoped to one site must not read the rosters of its owner's other sites.
- An exact email stays in `POST /api/sites/{siteId}/members`, where a hit adds the person and is audited. The candidates route never resolves an email, so it never answers whether an account exists.
- Which sites count is decided by `hasCapability` over the same member-row reading every gate uses (`listUserStanding` and `siteStanding`), with no role check of its own, so the suggestions follow any change to who holds SITE_MEMBER_MANAGE.
- A later request to search every account for site admins must argue against this ADR.
