import { useMutation } from "@tanstack/react-query";
import { LogInIcon, ShieldIcon } from "lucide-react";
import { useState } from "react";
import { api, call } from "@/api/client";
import { useHealth } from "@/api/queries";
import { Refusal } from "@/components/Refusal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Shown when /v1/me answers 401 (F-D8a): how to get a login link, and the email form when the
 * Install emails them (F-D8c). No shell: no one is signed in.
 */
export function SignedOut() {
  const health = useHealth();
  const emails = health.data?.sign_in_modes.includes("email_link") ?? false;
  return (
    <div className="min-h-svh bg-sidebar px-4">
      <main className="mx-auto flex w-full max-w-[520px] flex-col gap-4 pt-[72px] pb-12">
        <p className="text-center text-[15px] font-semibold tracking-[-0.01em]">Darkory</p>
        <div className="flex flex-col gap-3.5 rounded-lg border bg-card p-7 text-card-foreground shadow-soft">
          <h1 className="text-xl leading-tight font-semibold tracking-[-0.01em]">Sign in to Darkory</h1>
          <p className="leading-[1.55]">Darkory signs you in with a one-time login link. To get one:</p>
          <ul className="flex flex-col gap-2.5">
            <li className="grid grid-cols-[16px_minmax(0,1fr)] items-start gap-2.5 rounded-md border p-3 leading-[1.55]">
              <LogInIcon className="mt-0.5 size-3.5 text-muted-foreground" aria-hidden />
              <span>
                On the machine running the server, run <code>darkory login &lt;member&gt;</code> with your Member name, and open the
                link it prints.
              </span>
            </li>
            <li className="grid grid-cols-[16px_minmax(0,1fr)] items-start gap-2.5 rounded-md border p-3 leading-[1.55]">
              <ShieldIcon className="mt-0.5 size-3.5 text-muted-foreground" aria-hidden />
              <span>Or ask an admin of your Organisation to issue a login link for you.</span>
            </li>
          </ul>
          {emails && <EmailSignIn />}
        </div>
      </main>
    </div>
  );
}

function EmailSignIn() {
  const [email, setEmail] = useState("");
  const request = useMutation({
    mutationFn: (address: string) => call(api.POST("/v1/sign-in/email", { body: { email: address } })),
  });
  return (
    <section aria-labelledby="email-heading" className="flex flex-col gap-3.5 border-t pt-4">
      <h2 id="email-heading" className="text-[15px] font-semibold">
        Get a link by email
      </h2>
      {request.isSuccess ? (
        <p role="status">If {email} belongs to a Member, a login link is on its way. Open it in this browser.</p>
      ) : (
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            request.mutate(email);
          }}
        >
          <Label htmlFor="sign-in-email" className="text-[12.5px]">
            Email
          </Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="sign-in-email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-9 min-w-0 flex-1 basis-56"
            />
            <Button type="submit" size="md" disabled={request.isPending}>
              Email me a link
            </Button>
          </div>
        </form>
      )}
      <Refusal error={request.error} />
    </section>
  );
}
