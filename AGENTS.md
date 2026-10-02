# Pull request verification disclosures

When the user explicitly approves proceeding with a push despite incomplete automatic verification, include a brief notation under the existing Testing/Verification section at the bottom of the PR body (no warning banner at the top) stating:

- Which automatic verification ran and how far it completed.
- What remained incomplete, failed, or blocked.
- That the incomplete-verification gate was overridden with the user's explicit manual approval.

If the user reports checking the fix themselves, state that the user reports manually verifying it. Only claim manual verification or approval when the user actually confirmed it. This disclosure does not itself authorize bypassing verification or other approval requirements. Update the PR body when verification status changes.

Example: "Automatic verification was incomplete: build and unit tests passed; browser verification stopped before the checkout flow could be checked. Proceeding despite incomplete verification was explicitly approved manually by the user."

For PR body refreshes, manual verification must be explicitly confirmed using the update dialog’s checkbox. Keep automatic outcomes under “Automated verification results”; do not infer manual verification from approval to publish alone.
