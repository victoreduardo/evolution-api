import { Logtail } from "@logtail/node";

const logtailToken = process.env.LOGTAIL_TOKEN;
const logtailEndpoint = process.env.LOGTAIL_ENDPOINT;

let logtail = null;

if (logtailToken) {
  logtail = new Logtail(logtailToken, {
    endpoint: logtailEndpoint || undefined,
  });
}

export { logtail }; 