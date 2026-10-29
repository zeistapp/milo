# 03: Stop re-raising findings a maintainer rejected

**What to build:** When a maintainer closes a Milo ticket as not planned, nothing stops the next scan raising the same finding again, because planning passes only open issues and PRs to the scanner and verifier. Each repeat costs a scan, a verification and the maintainer's trust. Pass recently closed, not-planned Milo tickets in the scan's category (title and close reason or last maintainer comment) to the scanner and the verifier, as data. The verifier ends with `Verdict: clean` when the finding matches a rejected one by concept, not just by wording, unless the code has changed in a way that answers the rejection's reason.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent
- [ ] Planning fetches closed, not-planned tickets in the category, with a bounded count so large repos stay cheap
- [ ] The scanner and verifier both receive them, marked as data, not instructions
- [ ] A finding that restates a rejected ticket is not filed
- [ ] Tickets closed as completed are not treated as rejections
- [ ] A test covers the fetch and filtering
