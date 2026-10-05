import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { api, call } from "../api/client";
import { useHealth } from "../api/queries";
import { Refusal } from "../components/ui";

/** Shown when /v1/me answers 401: how to get a login link, and the email form when the Install emails them. */
export function SignedOut() {
  const health = useHealth();
  const emails = health.data?.sign_in_modes.includes("email_link") ?? false;
  return (
    <main className="page narrow">
      <h1>Sign in to Darkory</h1>
      <p>Darkory signs you in with a one-time login link. To get one:</p>
      <ul>
        <li>
          On the machine running the server, run <code>darkory login &lt;member&gt;</code> with your Member name, and
          open the link it prints.
        </li>
        <li>Or ask an admin of your Organisation to issue a login link for you.</li>
      </ul>
      {emails && <EmailSignIn />}
    </main>
  );
}

function EmailSignIn() {
  const [email, setEmail] = useState("");
  const request = useMutation({
    mutationFn: (address: string) => call(api.POST("/v1/sign-in/email", { body: { email: address } })),
  });
  return (
    <section aria-labelledby="email-heading">
      <h2 id="email-heading">Get a link by email</h2>
      {request.isSuccess ? (
        <p role="status">If {email} belongs to a Member, a login link is on its way. Open it in this browser.</p>
      ) : (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            request.mutate(email);
          }}
        >
          <label>
            Email
            <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <button type="submit" disabled={request.isPending}>
            Email me a link
          </button>
        </form>
      )}
      <Refusal error={request.error} />
    </section>
  );
}
