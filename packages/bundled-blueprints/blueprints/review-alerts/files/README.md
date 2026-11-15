# Review Alerts

Shows the Locations of one InferOps Project that are waiting for review.

- **Binding.** `PROJECT` is an InferLab operations connection to one Project
  (`inferops://<company>.<workspace>/project/project/<id>`). Its session is documented in the
  binding's own API (`describeBinding PROJECT`).
- **Server** (`server.ts`). `getReviewAlerts()` reads the Project and pages through its Locations
  (100 a page, at most 20 pages) and returns those whose `review.status` is `requested`. With no
  `PROJECT` bound it answers `notConnected`, never an empty list. A failed read answers `failed`
  with the documented error name (`NotFound`, `Forbidden`, `ConnectionExpired`, ...) and a message
  for a person.
- **Nothing of InferOps is stored.** Every call reads InferOps again, as the person who connected
  the Project, so the list is what that person may see now. A fresh gadget stores nothing.
- **Watching** (FAC-239). `watchReviews()` subscribes one persistent hook to the Project's
  committed events (`PROJECT.subscribe`, restored through `[restore]`), and stores only that it did,
  so a second watch makes no second hook. The hook starts disabled; the person turns it on in
  Activity. Each review requested then raises attention (`env.ATTENTION.raise`): the InferOps event
  id as the source, the Location as the target, and the holders of `location:write` in the event's
  workspace as the audience. The host checks the event is real and who may see it.
- **Client** (`client.ts`, `lib/render.ts`). Draws loading, not connected, failed, empty ("No
  Locations are waiting for review") and the list. Refresh reads again.
- **Export.** PDF of the page only.
