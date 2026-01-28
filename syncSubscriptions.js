import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const PLANS = [
  { id: "price_1S2vqlH3uTn0vrRgS9qmraPP", name: "STARTER", credits: 100 },
  { id: "price_1S2vroH3uTn0vrRgZVRzLkNr", name: "PRO", credits: 350 },
  { id: "price_1S2vsGH3uTn0vrRgzvgc2P9Q", name: "AGENCY", credits: 1000 },
];
/**
 * Fetch subscription details from Stripe
 */
async function getStripeSubscription(subscriptionId) {
  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ["schedule", "default_payment_method"],
    });
    return subscription;
  } catch (error) {
    if (error.code === "resource_missing") {
      console.log(`⚠️  Subscription ${subscriptionId} not found in Stripe`);
      return null;
    }
    throw error;
  }
}

const totalUserCredits = async (userId) => {
  const { data, error } = await supabase
    .from("credits")
    .select("amount.sum()")
    .eq("user_id", userId)
    .single();

  if (error) {
    console.error(error);
    return 0;
  }

  return data?.sum ?? 0;
};

const clearUserCredits = async (userId) => {
  const total = await totalUserCredits(userId);
  if (total === 0) {
    return;
  }

  const creditsRecord = {
    user_id: userId,
    amount: -total,
    source: "unused_credits_cleared",
    notes: `Credits not carry forward (-${total})`,
    created_at: new Date().toISOString().replace("T", " ").replace("Z", "+00"),
    updated_at: new Date().toISOString().replace("T", " ").replace("Z", "+00"),
    idempotency_key: null,
    video_id: null,
    showOnSite: false,
    video_type: "",
  };

  const { error } = await supabase.from("credits").insert(creditsRecord);

  if (error) {
    console.error(error);
    return false;
  }

  console.log(`💰 Cleared ${total} credits for user ${userId}`);

  return true;
};

/**
 * Map Stripe subscription data to database schema
 */
function mapStripeToDbSchema(stripeSub) {
  const planId = PLANS.find((plan) => plan.id === stripeSub.plan.id)?.name;

  const priceData = stripeSub.items.data[0]?.price;

  // Extract plan_id - adjust based on your setup
  //   const planId =
  //     priceData?.metadata?.plan_id ||
  //     priceData?.lookup_key ||
  //     priceData?.nickname ||
  //     "UNKNOWN";

  return {
    stripe_subscription_id: stripeSub.id,
    stripe_customer_id: stripeSub.customer,
    status: stripeSub.status,
    plan_id: planId,
    price_id: priceData?.id || null,
    current_period_start: new Date(stripeSub.current_period_start * 1000)
      .toISOString()
      .replace("T", " ")
      .replace("Z", "+00"),
    current_period_end: new Date(stripeSub.current_period_end * 1000)
      .toISOString()
      .replace("T", " ")
      .replace("Z", "+00"),
    cancel_at_period_end: stripeSub.cancel_at_period_end,
    updated_at: new Date().toISOString().replace("T", " ").replace("Z", "+00"),
  };
}

/**
 * Add credits record when subscription period ends
 */
async function addCreditsRecord(dbRecord, mappedData) {
  try {
    // Get the plan details to determine credits amount
    const plan = PLANS.find((p) => p.name === mappedData.plan_id);
    if (!plan) {
      console.log(`⚠️  Plan ${mappedData.plan_id} not found in PLANS array`);
      return;
    }

    // Create credits record
    const creditsRecord = {
      user_id: dbRecord.user_id, // Assuming user_id exists in dbRecord
      amount: plan.credits,
      source: "subscription",
      notes: `Subscription renewal (${mappedData.plan_id})`,
      created_at: new Date()
        .toISOString()
        .replace("T", " ")
        .replace("Z", "+00"),
      updated_at: new Date()
        .toISOString()
        .replace("T", " ")
        .replace("Z", "+00"),
      idempotency_key: null,
      video_id: null,
      showOnSite: false,
      video_type: "",
    };

    const { error } = await supabase.from("credits").insert(creditsRecord);

    if (error) throw error;

    console.log(
      `💰 Added ${plan.credits} credits for user ${dbRecord.user_id} (${mappedData.plan_id})`,
    );
  } catch (error) {
    console.error(
      `❌ Error adding credits record for subscription ${dbRecord.stripe_subscription_id}:`,
      error.message,
    );
  }
}

/**
 * Sync a single subscription
 */
async function syncSubscription(dbRecord) {
  try {
    const stripeSubscription = await getStripeSubscription(
      dbRecord.stripe_subscription_id,
    );

    if (!stripeSubscription) {
      // Subscription deleted in Stripe
      const { error } = await supabase
        .from("subscriptions")
        .update({
          status: "canceled",
          updated_at: new Date()
            .toISOString()
            .replace("T", " ")
            .replace("Z", "+00"),
        })
        .eq("stripe_subscription_id", dbRecord.stripe_subscription_id);

      if (error) throw error;

      return { status: "deleted", changes: true };
    }

    const mappedData = mapStripeToDbSchema(stripeSubscription);

    // Check for changes
    const hasChanges =
      dbRecord.status !== mappedData.status ||
      dbRecord.price_id !== mappedData.price_id ||
      dbRecord.plan_id !== mappedData.plan_id ||
      dbRecord.cancel_at_period_end !== mappedData.cancel_at_period_end ||
      new Date(dbRecord.current_period_end).getTime() !==
        new Date(mappedData.current_period_end).getTime();

    // Check if end date has changed (subscription renewal)
    const endDateChanged =
      new Date(dbRecord.current_period_end).getTime() !==
      new Date(mappedData.current_period_end).getTime();

    if (hasChanges) {
      const { error } = await supabase
        .from("subscriptions")
        .update(mappedData)
        .eq("stripe_subscription_id", dbRecord.stripe_subscription_id);

      if (error) throw error;

      // Add credits record if end date has changed (subscription renewed)
      if (endDateChanged) {
        await clearUserCredits(dbRecord.user_id);
        if (mappedData.status === "active") {
          await addCreditsRecord(dbRecord, mappedData);
        }
      }

      return { status: "updated", changes: true };
    }

    return { status: "no_change", changes: false };
  } catch (error) {
    console.error(
      `❌ Error syncing subscription ${dbRecord.stripe_subscription_id}:`,
      error.message,
    );
    return { status: "error", error: error.message };
  }
}

/**
 * Main sync function
 */
async function syncAllSubscriptions() {
  console.log("🔄 Starting subscription sync...");
  console.log("=".repeat(60));

  const startTime = Date.now();
  let stats = {
    total: 0,
    updated: 0,
    unchanged: 0,
    deleted: 0,
    errors: 0,
  };

  try {
    // Fetch all subscriptions from database (excluding null stripe_subscription_id)
    const { data: subscriptions, error } = await supabase
      .from("subscriptions")
      .select("*")
      .not("stripe_subscription_id", "is", null);

    console.log("Error:", error);
    // return;

    if (error) throw error;

    stats.total = subscriptions.length;
    console.log(`\n📊 Found ${stats.total} subscriptions to sync\n`);

    // Sync each subscription
    for (const subscription of subscriptions) {
      const result = await syncSubscription(subscription);

      if (result.status === "updated") stats.updated++;
      else if (result.status === "no_change") stats.unchanged++;
      else if (result.status === "deleted") stats.deleted++;
      else if (result.status === "error") stats.errors++;

      // Add delay to avoid rate limits
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log("\n" + "=".repeat(60));
    console.log("✅ SYNC COMPLETE");
    console.log("=".repeat(60));
    console.log(`📈 Statistics:`);
    console.log(`   Total subscriptions: ${stats.total}`);
    console.log(`   Updated: ${stats.updated}`);
    console.log(`   Unchanged: ${stats.unchanged}`);
    console.log(`   Deleted in Stripe: ${stats.deleted}`);
    console.log(`   Errors: ${stats.errors}`);
    console.log(`   Duration: ${duration}s`);

    return stats;
  } catch (error) {
    console.error("❌ Fatal error during sync:", error);
    throw error;
  }
}

// Run if executed directly
syncAllSubscriptions()
  .then(() => {
    console.log("\n✅ Sync completed successfully");
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n❌ Sync failed:", error);
    process.exit(1);
  });
