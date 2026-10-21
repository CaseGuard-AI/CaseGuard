import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { PageIntro } from "@/components/shell/page-intro";
import { Link } from "@/i18n/navigation";

export default function NotFound() {
  const t = useTranslations("NotFound");
  return (
    <>
      <PageIntro title={t("title")} subtitle={t("body")} />
      <Button asChild>
        <Link href="/">{t("back")}</Link>
      </Button>
    </>
  );
}
