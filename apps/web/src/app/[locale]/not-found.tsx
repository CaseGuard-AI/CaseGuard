import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";

// Outside the app shell, so it works whether or not the visitor is signed in.
export default function NotFound() {
  const t = useTranslations("NotFound");
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="max-w-sm text-center">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("body")}</p>
        <Button asChild className="mt-6">
          <Link href="/">{t("back")}</Link>
        </Button>
      </div>
    </main>
  );
}
