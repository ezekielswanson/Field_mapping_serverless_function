# Field_mapping_serverless_function
 
# `field-mapping` Serverless Function

## Purpose

BWC operates on **HubSpot CMS Enterprise**, which lacks cross‑object workflow automation features out of the box. The `field‑mapping` serverless function keeps the **Contact** object and BWC’s custom **Subscription** object in sync so that every roadside‑assistance membership record stays current and complete. Without it, staff would need to copy‑paste addresses, phone numbers, and membership numbers after each signup—an error‑prone, manual chore.

## What It Does

1. **Receives a Contact ID** from either a HubSpot workflow webhook or a manual API call.
2. **Returns an immediate `204`** so the webhook never times out, then continues processing asynchronously.
3. **Fetches the Contact and its associated Subscription records.** If the user is still checking out and no subscription exists yet, it waits up to **30 minutes**, polling every 10 minutes to catch delayed Stripe payments.
4. **Maps Contact → Subscription fields** only when data is present and different, avoiding unnecessary writes. Key mappings include `member_id`, `contracted_associates`, `member_card_no`, `address`, `city`, `state`, `zip`, `phone`.
5. **Patches each Subscription** with a single `PATCH /crm/v3/objects/{customObjectId}/{subscriptionId}` call, then logs a concise audit trail.

## Trigger & Entry Point

```js
exports.main = async (context, sendResponse) => { /* … */ };
```

The function runs inside HubSpot’s built‑in **Functions** runtime and is invoked by a workflow‑level webhook. A contact ID can also be supplied as a URL parameter for one‑off reprocessing.

### Environment Variables / Secrets

| Name               | Purpose                                                                  |
| ------------------ | ------------------------------------------------------------------------ |
| `fieldMappingKey`  | HubSpot private‑app token used for all CRM API calls                     |
| `customObjectType` | The Subscription object type ID (`2‑32975090`) hard‑coded in the script. |

## Retry Logic for Missing Subscriptions

Stripe can take a few minutes to create a subscription after payment. The helper `waitForSubscriptions` polls every 10 minutes (up to 30 minutes) before giving up. This prevents data mismatches when a Contact is created seconds before its Subscription.

## Response Schema

After processing, the async task logs — and optional API responses — use the shape:

```json
{
  "contactId": "104951",
  "status": "success | partial_success | warning | error",
  "updated": true,
  "totalSubscriptions": 1,
  "updatedSubscriptions": [{ "subscriptionId": "987", "actions": ["address", "member_card_no"] }],
  "errors": []
}
```

## Deployment Steps

1. **Copy `field‑mapping.js` into HubSpot → CRM Development → Functions.**
2. **Set the `fieldMappingKey` secret** to a private‑app token with `crm.objects.contacts.*` and `crm.objects.custom.*` scopes.
3. **Create a “Contact Created/Property Changed” workflow** and add a *Trigger Webhook* action pointing at this function’s URL.
4. Publish. New contacts and profile updates will now propagate to their associated Subscriptions automatically.

---

*Part of the Better World Club Automation Library*
