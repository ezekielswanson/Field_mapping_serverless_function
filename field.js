const hubspot = require('@hubspot/api-client');

// Wait for subscriptions with 10-minute retry logic due to async payment processing
const waitForSubscriptions = async (hubspotClient, contactId, customObjectType, maxWaitMinutes = 30) => {
  const checkIntervalMinutes = 10;
  const maxRetries = Math.floor(maxWaitMinutes / checkIntervalMinutes);
  let retryCount = 0;
  
  console.log(`Starting subscription wait - will check every ${checkIntervalMinutes} minutes for up to ${maxWaitMinutes} minutes`);
  
  while (retryCount < maxRetries) {
    try {
      const associationsResponse = await hubspotClient.apiRequest({
        method: 'GET',
        path: `/crm/v4/objects/contacts/${contactId}/associations/${customObjectType}`
      });
      const associations = associationsResponse.body;
      
      if (associations.results && associations.results.length > 0) {
        console.log(`Found ${associations.results.length} subscription(s) after ${retryCount * checkIntervalMinutes} minutes`);
        return associations;
      }
      
      retryCount++;
      
      if (retryCount < maxRetries) {
        const waitTime = checkIntervalMinutes * 60 * 1000;
        console.log(`No subscriptions found yet, waiting ${checkIntervalMinutes} minutes (attempt ${retryCount}/${maxRetries}) - User may still be completing payment`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
      
    } catch (error) {
      console.error(`Error checking for subscriptions: ${error.message}`);
      retryCount++;
      
      if (retryCount < maxRetries) {
        const waitTime = checkIntervalMinutes * 60 * 1000;
        console.log(`Retrying in ${checkIntervalMinutes} minutes due to error (attempt ${retryCount}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  console.log(`No subscriptions found after ${maxWaitMinutes} minutes - payment may not have been completed`);
  return null;
};

// Normalize associates format to HubSpot standard (semicolon-separated without spaces)
const normalizeAssociatesFormat = (associatesString) => {
  try {
    if (!associatesString || associatesString.trim() === '') {
      return null;
    }

    let normalized = associatesString.trim();
    let associates = [];
    
    if (normalized.includes(';')) {
      associates = normalized.split(';');
    } else if (normalized.includes(',')) {
      associates = normalized.split(',');
    } else {
      associates = [normalized];
    }
    
    associates = associates
      .map(name => name.trim())
      .filter(name => name.length > 0);
    
    return associates.join(';');
    
  } catch (error) {
    console.error(`Error normalizing associates: ${error.message}`);
    return null;
  }
};

// Process contact changes and update associated subscriptions
const processContactToSubscriptionMapping = async (hubspotClient, contactId, customObjectType) => {
  try {
    let contact;
    try {
      const contactResponse = await hubspotClient.apiRequest({
        method: 'GET',
        path: `/crm/v3/objects/contacts/${contactId}`,
        qs: {
          properties: 'hs_object_id,associates,member_card_no,firstname,lastname,email,address,street_address_2,city,phone,state,zip'
        }
      });
      contact = contactResponse.body;
      
      if (!contact || !contact.properties) {
        throw new Error(`Contact ${contactId} not found`);
      }
      
    } catch (contactError) {
      console.error(`Contact fetch failed: ${contactError.message}`);
      return {
        contactId,
        status: 'error',
        action: 'contact_fetch_error',
        updated: false,
        message: `Failed to fetch contact ${contactId}`,
        errorDetail: contactError.message
      };
    }

    const contactName = `${contact.properties.firstname || ''} ${contact.properties.lastname || ''}`.trim();
    console.log(`Processing contact: ${contactName} (${contact.properties.email})`);

    let associations;
    try {
      const associationsResponse = await hubspotClient.apiRequest({
        method: 'GET',
        path: `/crm/v4/objects/contacts/${contactId}/associations/${customObjectType}`
      });
      associations = associationsResponse.body;
      
      // User might still be completing payment, wait and retry
      if (!associations.results || associations.results.length === 0) {
        console.log(`No subscriptions found immediately - user may still be completing payment`);
        associations = await waitForSubscriptions(hubspotClient, contactId, customObjectType, 30);
        
        if (!associations) {
          console.log(`No subscriptions found for contact ${contactId} after 30 minutes`);
          return {
            contactId,
            contactEmail: contact.properties.email,
            contactName,
            status: 'warning',
            action: 'no_subscriptions_found',
            updated: false,
            message: 'No associated subscriptions found after waiting 30 minutes - payment may not have been completed'
          };
        }
      }
      
    } catch (associationsError) {
      console.error(`Associations fetch failed: ${associationsError.message}`);
      return {
        contactId,
        status: 'error',
        action: 'associations_fetch_error',
        updated: false,
        message: `Failed to fetch subscription associations`,
        errorDetail: associationsError.message
      };
    }

    console.log(`Found ${associations.results.length} subscription(s) to update`);

    let updatedSubscriptions = [];
    let errors = [];

    for (const association of associations.results) {
      const subscriptionId = association.toObjectId || association.to?.id;
      
      try {
        const subscriptionResponse = await hubspotClient.apiRequest({
          method: 'GET',
          path: `/crm/v3/objects/${customObjectType}/${subscriptionId}`,
          qs: {
            properties: 'member_id,contracted_associates,member_card_no,hs_object_id,address,street_address_2,city,phone,state,zip'
          }
        });
        
        const subscription = subscriptionResponse.body;
        if (!subscription || !subscription.properties) {
          throw new Error(`Subscription ${subscriptionId} not found`);
        }

        let updateProperties = {};
        let actions = [];

        // Map contact.hs_object_id → subscription.member_id
        if (!subscription.properties.member_id) {
          updateProperties.member_id = contact.id;
          actions.push(`member_id = ${contact.id}`);
        }

        // Map contact.associates → subscription.contracted_associates (normalized)
        if (contact.properties.associates && contact.properties.associates.trim() !== '') {
          const normalizedAssociates = normalizeAssociatesFormat(contact.properties.associates);
          if (normalizedAssociates && normalizedAssociates !== subscription.properties.contracted_associates) {
            updateProperties.contracted_associates = normalizedAssociates;
            actions.push(`contracted_associates = "${normalizedAssociates}"`);
          }
        }

        // Map contact.member_card_no → subscription.member_card_no
        if (contact.properties.member_card_no && contact.properties.member_card_no.trim() !== '') {
          if (contact.properties.member_card_no !== subscription.properties.member_card_no) {
            updateProperties.member_card_no = contact.properties.member_card_no;
            actions.push(`member_card_no = "${contact.properties.member_card_no}"`);
          }
        }

        // Map contact.address → subscription.address
        if (contact.properties.address && contact.properties.address.trim() !== '') {
          if (contact.properties.address !== subscription.properties.address) {
            updateProperties.address = contact.properties.address;
            actions.push(`address = "${contact.properties.address}"`);
          }
        }

        // Map contact.street_address_2 → subscription.street_address_2
        if (contact.properties.street_address_2 && contact.properties.street_address_2.trim() !== '') {
          if (contact.properties.street_address_2 !== subscription.properties.street_address_2) {
            updateProperties.street_address_2 = contact.properties.street_address_2;
            actions.push(`street_address_2 = "${contact.properties.street_address_2}"`);
          }
        }

        // Map contact.city → subscription.city
        if (contact.properties.city && contact.properties.city.trim() !== '') {
          if (contact.properties.city !== subscription.properties.city) {
            updateProperties.city = contact.properties.city;
            actions.push(`city = "${contact.properties.city}"`);
          }
        }

        // Map contact.phone → subscription.phone
        if (contact.properties.phone && contact.properties.phone.trim() !== '') {
          if (contact.properties.phone !== subscription.properties.phone) {
            updateProperties.phone = contact.properties.phone;
            actions.push(`phone = "${contact.properties.phone}"`);
          }
        }

        // Map contact.state → subscription.state
        if (contact.properties.state && contact.properties.state.trim() !== '') {
          if (contact.properties.state !== subscription.properties.state) {
            updateProperties.state = contact.properties.state;
            actions.push(`state = "${contact.properties.state}"`);
          }
        }

        // Map contact.zip → subscription.zip
        if (contact.properties.zip && contact.properties.zip.trim() !== '') {
          if (contact.properties.zip !== subscription.properties.zip) {
            updateProperties.zip = contact.properties.zip;
            actions.push(`zip = "${contact.properties.zip}"`);
          }
        }

        if (Object.keys(updateProperties).length > 0) {
          await hubspotClient.apiRequest({
            method: 'PATCH',
            path: `/crm/v3/objects/${customObjectType}/${subscriptionId}`,
            body: {
              properties: updateProperties
            }
          });
          
          console.log(`Updated subscription ${subscriptionId}: ${actions.join(', ')}`);
          updatedSubscriptions.push({
            subscriptionId,
            actions: actions
          });
        } else {
          console.log(`Subscription ${subscriptionId} already up to date`);
        }

      } catch (subscriptionError) {
        console.error(`Failed to update subscription ${subscriptionId}: ${subscriptionError.message}`);
        errors.push({
          subscriptionId,
          error: subscriptionError.message
        });
      }
    }

    return {
      contactId,
      contactEmail: contact.properties.email,
      contactName,
      status: errors.length === 0 ? 'success' : (updatedSubscriptions.length > 0 ? 'partial_success' : 'error'),
      action: updatedSubscriptions.length > 0 ? 'updated_subscriptions' : 'no_updates_needed',
      updated: updatedSubscriptions.length > 0,
      totalSubscriptions: associations.results.length,
      updatedSubscriptions: updatedSubscriptions,
      errors: errors
    };

  } catch (error) {
    console.error(`Error processing contact ${contactId}: ${error.message}`);
    return {
      contactId,
      status: 'error',
      action: 'processing_error',
      updated: false,
      message: `Processing failed`,
      errorDetail: error.message
    };
  }
};

// HubSpot serverless function entry point
exports.main = async (context, sendResponse) => {
  console.log('BWC Field Mapping Started');

  try {
    const token = context.secrets.fieldMappingKey;
    
    if (!token) {
      console.error('Missing access token');
      sendResponse({
        statusCode: 500,
        body: { status: 'error', message: 'Access token not configured' },
      });
      return;
    }

    const hubspotClient = new hubspot.Client({ accessToken: token });
    const customObjectType = '2-32975090';

    if (!hubspotClient.crm || !hubspotClient.apiRequest) {
      console.error('Missing essential APIs');
      sendResponse({
        statusCode: 500,
        body: {
          status: 'error',
          message: 'HubSpot API client missing essential APIs'
        },
      });
      return;
    }

    let body;
    try {
      if (typeof context.body === 'string') {
        body = JSON.parse(context.body);
      } else {
        body = context.body;
      }
    } catch (parseError) {
      console.error('Invalid request body');
      sendResponse({
        statusCode: 400,
        body: {
          status: 'error',
          message: 'Invalid request body format'
        },
      });
      return;
    }

    let contactId;
    
    if (Array.isArray(body) && body[0] && body[0].objectId) {
      contactId = body[0].objectId.toString();
      console.log(`Webhook: ${contactId}`);
    } else if (context.params && context.params.contactId) {
      contactId = context.params.contactId.toString();
      console.log(`Manual: ${contactId}`);
    } else if (body && body.contactId) {
      contactId = body.contactId.toString();
      console.log(`Body: ${contactId}`);
    } else {
      console.log('No contact ID provided');
      sendResponse({
        statusCode: 400,
        body: {
          status: 'error',
          message: 'No contact ID provided'
        },
      });
      return;
    }

    // Respond immediately to avoid HubSpot webhook timeout
    console.log(`Sending immediate 204 response for contact ${contactId}`);
    sendResponse({
      statusCode: 204,
      body: {}
    });

    // Process asynchronously to avoid webhook timeout pressure
    console.log(`Starting async processing for contact ${contactId}`);
    
    // Process after response is sent to avoid blocking webhook
    setTimeout(async () => {
      try {
        const result = await processContactToSubscriptionMapping(hubspotClient, contactId, customObjectType);
        
        if (result.status === 'success') {
          const message = result.action === 'updated_subscriptions' 
            ? `Successfully updated ${result.updatedSubscriptions.length}/${result.totalSubscriptions} subscription(s)`
            : 'No updates needed';
          console.log(`Async processing completed: ${contactId} - ${message}`);
        } else if (result.status === 'partial_success') {
          const message = `Updated ${result.updatedSubscriptions.length}/${result.totalSubscriptions} subscription(s), ${result.errors.length} failed`;
          console.log(`Async processing partial success: ${contactId} - ${message}`);
        } else {
          console.log(`Async processing warning: ${contactId} - ${result.message}`);
        }
        
      } catch (asyncError) {
        console.error(`Async processing failed for contact ${contactId}: ${asyncError.message}`);
      }
    }, 100);

  } catch (error) {
    console.error(`Function error: ${error.message}`);
    
    sendResponse({
      statusCode: 500,
      body: {
        status: 'error',
        message: 'Processing failed',
        errorDetail: error.message
      },
    });
  }
};